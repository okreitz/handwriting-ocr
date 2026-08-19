import { splitDocumentIntoPages } from "./pdf-pages.js";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const SUPPORTED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  ...SUPPORTED_IMAGE_TYPES,
]);

const DEFAULT_OCR_CONCURRENCY = 3;
const PREVIOUS_PAGE_CONTEXT_LENGTH = 400;

function toMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requireProvider(settings, providerName) {
  const provider = settings.providers?.[providerName];
  if (!provider?.enabled) {
    throw new Error(`Provider "${providerName}" is not enabled in settings.`);
  }
  return provider;
}

function requireModelConfig(modelConfig, label) {
  if (!modelConfig?.provider || !modelConfig?.model) {
    throw new Error(`${label} provider and model must be configured in settings.`);
  }
  return modelConfig;
}

async function callOpenRouter({ provider, model, messages }) {
  if (!provider.apiKey) {
    throw new Error("OpenRouter API key is missing. Add it in Settings.");
  }

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      "Content-Type": "application/json",
      ...(provider.referer ? { "HTTP-Referer": provider.referer } : {}),
      ...(provider.appName ? { "X-Title": provider.appName } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const details = data?.error?.message || JSON.stringify(data);
    throw new Error(`OpenRouter request failed: ${details}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => item?.text || "")
      .join("\n")
      .trim();
  }

  throw new Error("OpenRouter returned an unexpected response shape.");
}

async function runOcrStep(page, settings, { pageCount }) {
  const ocrModel = requireModelConfig(settings.ocrModel, "OCR model");

  if (ocrModel.provider !== "openrouter") {
    throw new Error(
      `OCR provider "${ocrModel.provider}" is not implemented yet. Start with OpenRouter in this version.`
    );
  }

  const provider = requireProvider(settings, "openrouter");
  const dataUrl = `data:${page.mimeType};base64,${page.base64}`;
  const attachmentPayload =
    page.mimeType === "application/pdf"
      ? {
          type: "file",
          file: {
            filename: page.fileName || "document.pdf",
            file_data: dataUrl,
          },
        }
      : {
          type: "image_url",
          image_url: {
            url: dataUrl,
          },
        };

  const pageLabel =
    pageCount > 1
      ? `This is page ${page.pageNumber} of a ${pageCount}-page document. Transcribe only this page, exactly.`
      : "Transcribe this uploaded handwritten document exactly.";

  return callOpenRouter({
    provider,
    model: ocrModel.model,
    messages: [
      {
        role: "system",
        content: settings.prompts.ocr,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: pageLabel,
          },
          attachmentPayload,
        ],
      },
    ],
  });
}

async function runCorrectionStep(ocrText, settings, { previousPageTail } = {}) {
  const correctionModel = requireModelConfig(
    settings.correctionModel,
    "Correction model"
  );

  if (correctionModel.provider !== "openrouter") {
    throw new Error(
      `Correction provider "${correctionModel.provider}" is not implemented yet. Start with OpenRouter in this version.`
    );
  }

  const provider = requireProvider(settings, "openrouter");
  const context = previousPageTail
    ? `The previous page ended with the following text. Use it only to resolve words broken across the page break, and do not repeat it in your answer:\n"""\n${previousPageTail}\n"""\n\n`
    : "";

  return callOpenRouter({
    provider,
    model: correctionModel.model,
    messages: [
      {
        role: "system",
        content: settings.prompts.correction,
      },
      {
        role: "user",
        content: `${context}Correct this OCR transcription:\n\n${ocrText}`,
      },
    ],
  });
}

function resolveConcurrency(settings, pageTotal) {
  const configured = Number(settings.pipeline?.ocrConcurrency);
  const limit =
    Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_OCR_CONCURRENCY;
  return Math.max(1, Math.min(limit, pageTotal));
}

// Runs `worker` over `items` with a bounded number in flight, and returns one
// promise per item in original order so the caller can consume them in sequence.
function startWithConcurrency(items, limit, worker) {
  const deferreds = items.map(() => {
    let resolve;
    const promise = new Promise((resolveFn) => {
      resolve = resolveFn;
    });
    return { promise, resolve };
  });

  let nextIndex = 0;
  const runNext = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      deferreds[index].resolve(await worker(items[index]));
    }
  };

  for (let slot = 0; slot < limit; slot += 1) {
    runNext();
  }

  return deferreds.map((deferred) => deferred.promise);
}

export async function* transcribeDocumentPages(filePayload, settings, options = {}) {
  if (!filePayload?.base64 || !filePayload?.mimeType) {
    throw new Error("Missing uploaded document payload.");
  }

  if (!SUPPORTED_DOCUMENT_TYPES.has(filePayload.mimeType)) {
    throw new Error("Unsupported file type. Use PDF, PNG, JPG, or WEBP.");
  }

  const startedAt = new Date().toISOString();
  const { pageCount, pages } = await splitDocumentIntoPages(filePayload, {
    pageRange: options.pageRange,
  });

  yield {
    type: "start",
    startedAt,
    fileName: filePayload.fileName || "document",
    pageCount,
    pageNumbers: pages.map((page) => page.pageNumber),
  };

  // OCR runs several pages at a time, correction stays sequential so each page
  // can see where the previous one left off.
  const ocrResults = startWithConcurrency(
    pages,
    resolveConcurrency(settings, pages.length),
    async (page) => {
      try {
        return { text: await runOcrStep(page, settings, { pageCount }) };
      } catch (error) {
        return { error: toMessage(error) };
      }
    }
  );

  let previousPageTail = "";
  let failedPages = 0;

  for (const [index, page] of pages.entries()) {
    const ocr = await ocrResults[index];
    let correctedTranscription = "";
    let error = ocr.error || null;

    if (!error) {
      try {
        correctedTranscription = await runCorrectionStep(ocr.text, settings, {
          previousPageTail,
        });
        previousPageTail = correctedTranscription.slice(
          -PREVIOUS_PAGE_CONTEXT_LENGTH
        );
      } catch (correctionError) {
        error = toMessage(correctionError);
      }
    }

    if (error) {
      failedPages += 1;
    }

    yield {
      type: "page",
      page: {
        pageNumber: page.pageNumber,
        rawTranscription: ocr.text || "",
        correctedTranscription,
        error,
      },
    };
  }

  yield {
    type: "done",
    startedAt,
    completedAt: new Date().toISOString(),
    fileName: filePayload.fileName || "document",
    pageCount,
    transcribedPages: pages.length,
    failedPages,
  };
}
