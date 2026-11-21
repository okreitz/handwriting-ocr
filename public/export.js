import { finalText, finishedPages, state } from "./state.js";

function buildFileName(suffix) {
  const originalName = state.file?.name || "transcription";
  return `${originalName.replace(/\.[^.]+$/, "")}-${suffix}.txt`;
}

function pageBody(page, readText) {
  if (page.status === "failed") {
    return `[Transcription failed: ${page.error}]`;
  }
  return readText(page).trim();
}

function buildDocumentText(readText) {
  const pages = finishedPages();

  if (state.pageCount <= 1) {
    return pages.length > 0 ? pageBody(pages[0], readText) : "";
  }

  return pages
    .map((page) => `--- Page ${page.pageNumber} ---\n\n${pageBody(page, readText)}`)
    .join("\n\n");
}

function download(text, fileName) {
  if (!text) {
    return;
  }

  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function saveDocument() {
  download(buildDocumentText(finalText), buildFileName("transcription"));
}

export function saveUncorrectedDocument() {
  download(
    buildDocumentText((page) => page.rawTranscription),
    buildFileName("uncorrected")
  );
}

export function savePage(page) {
  download(pageBody(page, finalText), buildFileName(`page-${page.pageNumber}`));
}
