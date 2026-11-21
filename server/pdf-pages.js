import { toMessage } from "./util.js";

const PDF_MIME_TYPE = "application/pdf";

export function parsePageRange(rangeText, pageCount) {
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

    for (let page = start; page <= Math.min(end, pageCount); page += 1) {
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

async function loadPdf(bytes) {
  // pdf-lib is only needed for PDFs, so it is loaded on first use.
  const { PDFDocument } = await import("pdf-lib");
  let sourcePdf;

  try {
    sourcePdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (error) {
    throw new Error(`Could not read this PDF: ${toMessage(error)}`);
  }

  if (sourcePdf.isEncrypted) {
    throw new Error(
      "This PDF is password-protected. Save an unprotected copy and try again."
    );
  }

  return { PDFDocument, sourcePdf };
}

// Describes the pages of an upload without extracting them yet. Each page has
// a `load()` that produces its bytes on demand, so the first model call does
// not wait for a long PDF to be split completely.
export async function openDocument({ bytes, mimeType, fileName }, { pageRange } = {}) {
  if (mimeType !== PDF_MIME_TYPE) {
    return {
      pageCount: 1,
      pages: [{ pageNumber: 1, load: async () => ({ bytes, mimeType, fileName }) }],
    };
  }

  const { PDFDocument, sourcePdf } = await loadPdf(bytes);
  const pageCount = sourcePdf.getPageCount();

  if (pageCount === 0) {
    throw new Error("This PDF has no pages.");
  }

  const baseName = (fileName || "document.pdf").replace(/\.pdf$/i, "");

  const pages = parsePageRange(pageRange, pageCount).map((pageNumber) => ({
    pageNumber,
    load: async () => {
      const singlePagePdf = await PDFDocument.create();
      const [copiedPage] = await singlePagePdf.copyPages(sourcePdf, [pageNumber - 1]);
      singlePagePdf.addPage(copiedPage);
      return {
        bytes: Buffer.from(await singlePagePdf.save()),
        mimeType: PDF_MIME_TYPE,
        fileName: `${baseName}-page-${pageNumber}.pdf`,
      };
    },
  }));

  return { pageCount, pages };
}
