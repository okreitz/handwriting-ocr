import { PDFDocument } from "pdf-lib";

const PDF_MIME_TYPE = "application/pdf";

function parsePageRange(rangeText, pageCount) {
  const allPages = () =>
    Array.from({ length: pageCount }, (unused, index) => index + 1);

  if (!rangeText || !rangeText.trim()) {
    return allPages();
  }

  const selected = new Set();

  for (const part of rangeText.split(",")) {
    const token = part.trim();
    if (!token) {
      continue;
    }

    const match = token.match(/^(\d+)?\s*(-)?\s*(\d+)?$/);
    if (!match || (!match[1] && !match[3])) {
      throw new Error(
        `Could not read page range "${token}". Use formats like 1, 3-7, or 10-.`
      );
    }

    const [, rawStart, dash, rawEnd] = match;

    if (!dash) {
      selected.add(Number(rawStart));
      continue;
    }

    const start = rawStart ? Number(rawStart) : 1;
    const end = rawEnd ? Number(rawEnd) : pageCount;

    if (start > end) {
      throw new Error(`Page range "${token}" starts after it ends.`);
    }

    for (let page = start; page <= end; page += 1) {
      selected.add(page);
    }
  }

  const pages = [...selected].filter((page) => page >= 1 && page <= pageCount);
  pages.sort((left, right) => left - right);

  if (pages.length === 0) {
    throw new Error(
      `The selected pages are outside this document, which has ${pageCount} page${
        pageCount === 1 ? "" : "s"
      }.`
    );
  }

  return pages;
}

async function loadPdf(base64) {
  const bytes = Buffer.from(base64, "base64");

  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read this PDF: ${details}`);
  }
}

async function extractSinglePage(sourcePdf, pageIndex) {
  const singlePagePdf = await PDFDocument.create();
  const [copiedPage] = await singlePagePdf.copyPages(sourcePdf, [pageIndex]);
  singlePagePdf.addPage(copiedPage);
  return singlePagePdf.saveAsBase64();
}

export async function splitDocumentIntoPages(filePayload, { pageRange } = {}) {
  if (filePayload.mimeType !== PDF_MIME_TYPE) {
    return {
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          mimeType: filePayload.mimeType,
          base64: filePayload.base64,
          fileName: filePayload.fileName,
        },
      ],
    };
  }

  const sourcePdf = await loadPdf(filePayload.base64);
  const pageCount = sourcePdf.getPageCount();

  if (pageCount === 0) {
    throw new Error("This PDF has no pages.");
  }

  const selectedPages = parsePageRange(pageRange, pageCount);
  const baseName = (filePayload.fileName || "document.pdf").replace(/\.pdf$/i, "");
  const pages = [];

  for (const pageNumber of selectedPages) {
    pages.push({
      pageNumber,
      mimeType: PDF_MIME_TYPE,
      base64: await extractSinglePage(sourcePdf, pageNumber - 1),
      fileName: `${baseName}-page-${pageNumber}.pdf`,
    });
  }

  return { pageCount, pages };
}
