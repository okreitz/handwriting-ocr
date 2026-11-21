// Shared UI state. Pages are keyed by page number and have a status of
// "pending", "running", "done", "failed" or "skipped".
export const state = {
  file: null,
  settings: null,
  availableModels: [],
  isRunning: false,
  abortController: null,
  correctionEnabled: false,
  pages: new Map(),
  pageNumbers: [],
  pageCount: 0,
  activePageNumber: null,
  previewUrl: null,
};

export function createPage(pageNumber) {
  return {
    pageNumber,
    status: "pending",
    rawTranscription: "",
    correctedTranscription: "",
    error: null,
    warning: null,
  };
}

// The text a reader wants for a page: the corrected version when the
// correction pass ran, otherwise what the reading model wrote.
export function finalText(page) {
  return state.correctionEnabled ? page.correctedTranscription : page.rawTranscription;
}

export function finishedPages() {
  return state.pageNumbers
    .map((pageNumber) => state.pages.get(pageNumber))
    .filter((page) => page && (page.status === "done" || page.status === "failed"));
}
