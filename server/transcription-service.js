import { cacheKey, readCache, writeCache } from "./cache.js";
import { streamChat } from "./openrouter.js";
import { openDocument } from "./pdf-pages.js";
import { createDeferred, createEventQueue, runPool, toMessage } from "./util.js";

const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const PDF_MIME_TYPE = "application/pdf";
const PREVIOUS_PAGE_CONTEXT_LENGTH = 400;
const TRUNCATED_WARNING =
  "The model stopped before finishing this page, so the end may be missing.";

export function isSupportedDocumentType(mimeType) {
  return mimeType === PDF_MIME_TYPE || SUPPORTED_IMAGE_TYPES.has(mimeType);
}

function buildOcrMessages({ pageData, pageNumber, pageCount, prompt }) {
  const dataUrl = `data:${pageData.mimeType};base64,${pageData.bytes.toString("base64")}`;
  const attachment =
    pageData.mimeType === PDF_MIME_TYPE
      ? {
          type: "file",
          file: { filename: pageData.fileName || "document.pdf", file_data: dataUrl },
        }
      : { type: "image_url", image_url: { url: dataUrl } };

  const pageLabel =
    pageCount > 1
      ? `This is page ${pageNumber} of a ${pageCount}-page document. Transcribe only this page, exactly.`
      : "Transcribe this handwritten document exactly.";

  return [
    { role: "system", content: prompt },
    { role: "user", content: [{ type: "text", text: pageLabel }, attachment] },
  ];
}

function buildCorrectionMessages({ ocrText, previousPageTail, prompt }) {
  const context = previousPageTail
    ? `The previous page ended with the following text. Use it only to resolve words broken across the page break, and do not repeat it in your answer:\n"""\n${previousPageTail}\n"""\n\n`
    : "";

  return [
    { role: "system", content: prompt },
    { role: "user", content: `${context}Correct this transcription:\n\n${ocrText}` },
  ];
}

// Runs one model call, answering from the result cache when the same input has
// been transcribed before. Truncated answers are never cached.
async function cachedCompletion({ key, fresh, emptyMessage, request, onDelta }) {
  if (!fresh) {
    const hit = await readCache(key);
    if (hit?.text) {
      return { text: hit.text, truncated: false, cached: true };
    }
  }

  const { text, finishReason } = await streamChat({ ...request, onDelta });
  if (!text) {
    throw new Error(emptyMessage);
  }

  const truncated = finishReason === "length";
  if (!truncated) {
    await writeCache(key, { text, model: request.model, savedAt: new Date().toISOString() });
  }

  return { text, truncated, cached: false };
}

// Transcribes a document page by page and yields progress events:
//   start      - page count and the page numbers that will be transcribed
//   page-delta - a piece of text for one page as the model writes it
//   page       - the finished result for one page (success or failure)
//   done       - summary once every page has settled
// Pages run concurrently, so `page` events can arrive out of order.
export async function* transcribeDocumentPages(file, settings, options = {}) {
  const { pageRange, signal, fresh = false } = options;

  if (!file?.bytes?.length || !file?.mimeType) {
    throw new Error("Missing uploaded document.");
  }

  if (!isSupportedDocumentType(file.mimeType)) {
    throw new Error("Unsupported file type. Use PDF, PNG, JPG, or WEBP.");
  }

  const provider = settings.providers.openrouter;
  if (!provider.apiKey) {
    throw new Error("OpenRouter API key is missing. Add it in Settings.");
  }

  const startedAt = new Date().toISOString();
  const { pageCount, pages } = await openDocument(file, { pageRange });
  const correctionEnabled = Boolean(settings.pipeline.correctionEnabled);
  const fileName = file.fileName || "document";
  const queue = createEventQueue();
  // One promise per page for its raw OCR text, so the correction of page N can
  // look at the end of page N-1 without waiting for that page's correction.
  const ocrTexts = pages.map(() => createDeferred());
  // Pages are identified by the uploaded file plus their number. The bytes of
  // an extracted PDF page are no use here: they contain a fresh timestamp.
  const documentHash = cacheKey(file.bytes);
  let failedPages = 0;

  const transcribePage = async (page, index) => {
    const result = {
      pageNumber: page.pageNumber,
      rawTranscription: "",
      correctedTranscription: "",
      error: null,
      warning: null,
      cached: false,
    };
    const emitDelta = (stage) => (text) =>
      queue.push({ type: "page-delta", pageNumber: page.pageNumber, stage, text });

    try {
      if (signal?.aborted) {
        return;
      }

      const pageData = await page.load();
      const ocr = await cachedCompletion({
        key: cacheKey(
          "ocr",
          documentHash,
          `${page.pageNumber}/${pageCount}`,
          settings.ocrModel.model,
          settings.prompts.ocr
        ),
        fresh,
        emptyMessage: "The model returned no text for this page.",
        onDelta: emitDelta("ocr"),
        request: {
          provider,
          model: settings.ocrModel.model,
          signal,
          messages: buildOcrMessages({
            pageData,
            pageNumber: page.pageNumber,
            pageCount,
            prompt: settings.prompts.ocr,
          }),
        },
      });

      result.rawTranscription = ocr.text;
      result.cached = ocr.cached;
      result.warning = ocr.truncated ? TRUNCATED_WARNING : null;
      ocrTexts[index].resolve(ocr.text);

      if (correctionEnabled) {
        const previous = pages[index - 1];
        const previousText =
          previous && previous.pageNumber === page.pageNumber - 1
            ? await ocrTexts[index - 1].promise
            : "";
        const previousPageTail = previousText.slice(-PREVIOUS_PAGE_CONTEXT_LENGTH);

        const correction = await cachedCompletion({
          key: cacheKey(
            "correction",
            ocr.text,
            settings.correctionModel.model,
            settings.prompts.correction,
            previousPageTail
          ),
          fresh,
          emptyMessage: "The correction model returned no text for this page.",
          onDelta: emitDelta("correction"),
          request: {
            provider,
            model: settings.correctionModel.model,
            // Correction is a light clean-up, so deep reasoning only adds delay.
            reasoningEffort: "low",
            signal,
            messages: buildCorrectionMessages({
              ocrText: ocr.text,
              previousPageTail,
              prompt: settings.prompts.correction,
            }),
          },
        });

        result.correctedTranscription = correction.text;
        result.cached = ocr.cached && correction.cached;
        if (correction.truncated) {
          result.warning = TRUNCATED_WARNING;
        }
      }
    } catch (error) {
      result.error = toMessage(error);
    } finally {
      // Never leave the next page waiting on a page that failed.
      ocrTexts[index].resolve(result.rawTranscription);
    }

    if (signal?.aborted) {
      return;
    }
    if (result.error) {
      failedPages += 1;
    }
    queue.push({ type: "page", page: result });
  };

  queue.push({
    type: "start",
    startedAt,
    fileName,
    pageCount,
    pageNumbers: pages.map((page) => page.pageNumber),
    correctionEnabled,
  });

  runPool(pages, settings.pipeline.ocrConcurrency, transcribePage).then(
    () => {
      if (!signal?.aborted) {
        queue.push({
          type: "done",
          startedAt,
          completedAt: new Date().toISOString(),
          fileName,
          pageCount,
          transcribedPages: pages.length,
          failedPages,
        });
      }
      queue.close();
    },
    (error) => queue.close(error)
  );

  yield* queue;
}
