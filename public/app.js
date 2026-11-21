import { transcribe } from "./api.js";
import { saveDocument, savePage, saveUncorrectedDocument } from "./export.js";
import { prepareUpload } from "./image.js";
import { initSettings } from "./settings.js";
import { createPage, finalText, finishedPages, state } from "./state.js";

const fileInput = document.querySelector("#file-input");
const uploadLabel = document.querySelector(".upload-button");
const transcribeButton = document.querySelector("#transcribe-button");
const stopButton = document.querySelector("#stop-button");
const fileMeta = document.querySelector("#file-meta");
const primaryTitle = document.querySelector("#primary-title");
const primaryOutput = document.querySelector("#primary-output");
const rawCard = document.querySelector("#raw-card");
const rawOutput = document.querySelector("#raw-output");
const statusPill = document.querySelector("#status-pill");
const saveTextButton = document.querySelector("#save-text-button");
const saveRawButton = document.querySelector("#save-raw-button");
const savePageButton = document.querySelector("#save-page-button");
const rerunPageButton = document.querySelector("#rerun-page-button");
const pageRangeInput = document.querySelector("#page-range-input");
const pageNav = document.querySelector("#page-nav");
const pageSelect = document.querySelector("#page-select");
const prevPageButton = document.querySelector("#prev-page");
const nextPageButton = document.querySelector("#next-page");
const pageProgress = document.querySelector("#page-progress");
const pageError = document.querySelector("#page-error");
const documentPreview = document.querySelector("#document-preview");
const previewMeta = document.querySelector("#preview-meta");
const previewPlaceholder = document.querySelector("#preview-placeholder");
const previewImage = document.querySelector("#preview-image");
const previewFrame = document.querySelector("#preview-frame");

const IDLE_TEXT = "Your transcription will appear here.";

function isPdf(file) {
  return file?.type === "application/pdf";
}

function activePage() {
  return state.pages.get(state.activePageNumber) || null;
}

function setStatus(kind, label) {
  statusPill.className = `status-pill ${kind}`;
  statusPill.textContent = label;
}

// --- Document preview -------------------------------------------------------

function clearPreview() {
  if (state.previewUrl) {
    URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = null;
  }

  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  previewFrame.hidden = true;
  previewFrame.removeAttribute("src");
  previewPlaceholder.hidden = false;
  previewMeta.textContent = "No preview available";
  documentPreview.classList.add("empty");
}

function updatePreview() {
  clearPreview();

  if (!state.file) {
    return;
  }

  const target = isPdf(state.file)
    ? previewFrame
    : state.file.type.startsWith("image/")
      ? previewImage
      : null;

  if (!target) {
    previewMeta.textContent = "Preview unavailable for this file type";
    return;
  }

  state.previewUrl = URL.createObjectURL(state.file);
  target.src = isPdf(state.file) ? `${state.previewUrl}#page=1` : state.previewUrl;
  target.hidden = false;
  previewPlaceholder.hidden = true;
  previewMeta.textContent = isPdf(state.file) ? "PDF preview" : "Image preview";
  documentPreview.classList.remove("empty");
}

// Keeps the original document on the same page the transcription panel shows.
function syncPreviewPage(pageNumber) {
  if (!state.previewUrl || !isPdf(state.file)) {
    return;
  }

  previewFrame.src = `${state.previewUrl}#page=${pageNumber}`;
  previewMeta.textContent =
    state.pageCount > 1
      ? `PDF preview • page ${pageNumber} of ${state.pageCount}`
      : "PDF preview";
}

// --- Rendering --------------------------------------------------------------

function pageOptionLabel(page) {
  const suffix = {
    pending: " — waiting",
    running: " — reading...",
    failed: " — failed",
    skipped: " — not transcribed",
    done: "",
  }[page.status];
  return `Page ${page.pageNumber}${suffix}`;
}

function buildPageOptions() {
  pageSelect.replaceChildren(
    ...state.pageNumbers.map((pageNumber) => {
      const option = document.createElement("option");
      option.value = String(pageNumber);
      option.textContent = pageOptionLabel(state.pages.get(pageNumber));
      return option;
    })
  );
  pageNav.hidden = state.pageNumbers.length <= 1;
}

function renderControls() {
  const index = state.pageNumbers.indexOf(state.activePageNumber);
  const page = activePage();
  const finished = finishedPages();

  if (state.activePageNumber !== null) {
    pageSelect.value = String(state.activePageNumber);
  }
  prevPageButton.disabled = index <= 0;
  nextPageButton.disabled = index < 0 || index >= state.pageNumbers.length - 1;
  pageProgress.textContent =
    state.pageNumbers.length > 1
      ? `${finished.length} of ${state.pageNumbers.length} pages finished`
      : "";

  const hasText = finished.some((entry) => entry.status === "done");
  saveTextButton.disabled = !hasText;
  saveRawButton.disabled = !hasText;
  saveRawButton.hidden = !state.correctionEnabled;
  savePageButton.disabled = page?.status !== "done";
  rerunPageButton.disabled =
    state.isRunning || !page || page.status === "pending" || page.status === "running";

  transcribeButton.disabled = !state.file || state.isRunning;
  transcribeButton.hidden = state.isRunning;
  stopButton.hidden = !state.isRunning;
  fileInput.disabled = state.isRunning;
  uploadLabel.classList.toggle("disabled", state.isRunning);
}

function updatePageOption(page) {
  const option = pageSelect.querySelector(`option[value="${page.pageNumber}"]`);
  if (option) {
    option.textContent = pageOptionLabel(page);
  }
}

function placeholderFor(page) {
  return {
    pending: "Waiting for a free slot...",
    running: "Reading the page...",
    failed: "No text for this page.",
    skipped: "This page was not transcribed.",
    done: "This page came back empty.",
  }[page.status];
}

function renderActivePage() {
  const page = activePage();
  primaryTitle.textContent = state.correctionEnabled ? "Corrected text" : "Transcription";
  rawCard.hidden = !state.correctionEnabled;

  if (!page) {
    pageError.hidden = true;
    return;
  }

  const notice = page.error
    ? `Page ${page.pageNumber} failed: ${page.error}`
    : page.warning;
  pageError.hidden = !notice;
  pageError.textContent = notice || "";

  if (state.correctionEnabled) {
    rawOutput.textContent = page.rawTranscription || placeholderFor(page);
    primaryOutput.textContent =
      page.correctedTranscription ||
      (page.status === "running" && page.rawTranscription
        ? "Correcting..."
        : placeholderFor(page));
  } else {
    primaryOutput.textContent = page.rawTranscription || placeholderFor(page);
  }
}

// Streamed text arrives many times per second, so repaints are batched.
let renderQueued = false;
function scheduleActivePageRender() {
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderActivePage();
  });
}

function setActivePage(pageNumber) {
  if (!state.pages.has(pageNumber)) {
    return;
  }

  state.activePageNumber = pageNumber;
  renderActivePage();
  renderControls();
  syncPreviewPage(pageNumber);
}

function stepPage(offset) {
  const index = state.pageNumbers.indexOf(state.activePageNumber);
  if (index >= 0) {
    setActivePage(state.pageNumbers[index + offset]);
  }
}

function resetPages() {
  state.pages = new Map();
  state.pageNumbers = [];
  state.pageCount = 0;
  state.activePageNumber = null;
  pageNav.hidden = true;
  pageSelect.replaceChildren();
  pageError.hidden = true;
  rawCard.hidden = true;
  primaryTitle.textContent = "Transcription";
  primaryOutput.textContent = IDLE_TEXT;
  renderControls();
}

// --- Transcription run ------------------------------------------------------

function updateProgressStatus() {
  const total = state.pageNumbers.length;
  setStatus(
    "running",
    total > 1 ? `Running ${finishedPages().length}/${total}` : "Running"
  );
}

function handleEvent(event, { rerunPage }) {
  if (event.type === "start") {
    state.correctionEnabled = event.correctionEnabled;

    if (rerunPage === null) {
      state.pageCount = event.pageCount;
      state.pageNumbers = event.pageNumbers;
      state.pages = new Map(
        event.pageNumbers.map((pageNumber) => [pageNumber, createPage(pageNumber)])
      );
      buildPageOptions();
      setActivePage(event.pageNumbers[0]);
    }

    updateProgressStatus();
    return;
  }

  if (event.type === "page-delta") {
    const page = state.pages.get(event.pageNumber);
    if (!page) {
      return;
    }

    if (page.status !== "running") {
      page.status = "running";
      updatePageOption(page);
    }
    if (event.stage === "correction") {
      page.correctedTranscription += event.text;
    } else {
      page.rawTranscription += event.text;
    }
    if (page.pageNumber === state.activePageNumber) {
      scheduleActivePageRender();
    }
    return;
  }

  if (event.type === "page") {
    const page = { ...event.page, status: event.page.error ? "failed" : "done" };
    state.pages.set(page.pageNumber, page);
    updatePageOption(page);
    if (page.pageNumber === state.activePageNumber) {
      renderActivePage();
    }
    renderControls();
    updateProgressStatus();
    return;
  }

  if (event.type === "error") {
    throw new Error(event.details || event.error || "Transcription failed.");
  }
}

function markUnfinishedPages(status) {
  for (const page of state.pages.values()) {
    if (page.status === "pending" || page.status === "running") {
      state.pages.set(page.pageNumber, { ...createPage(page.pageNumber), status });
      updatePageOption(state.pages.get(page.pageNumber));
    }
  }
}

function finishStatus() {
  const failed = finishedPages().filter((page) => page.status === "failed").length;
  if (failed === state.pageNumbers.length) {
    setStatus("error", "Error");
  } else if (failed > 0) {
    setStatus("done", `Done • ${failed} failed`);
  } else {
    setStatus("done", "Done");
  }
}

// Runs the whole selection, or a single page again when `rerunPage` is given.
// A re-run skips the result cache so the model really reads the page again.
async function runTranscription({ rerunPage = null } = {}) {
  if (!state.file || state.isRunning) {
    return;
  }

  state.isRunning = true;
  state.abortController = new AbortController();
  const { signal } = state.abortController;

  const previousResult = rerunPage === null ? null : state.pages.get(rerunPage);

  if (rerunPage === null) {
    resetPages();
    primaryOutput.textContent = "Preparing the document...";
  } else {
    state.pages.set(rerunPage, createPage(rerunPage));
    updatePageOption(state.pages.get(rerunPage));
    renderActivePage();
  }
  renderControls();
  setStatus("running", "Running");

  try {
    const upload = await prepareUpload(state.file);
    const events = transcribe({
      ...upload,
      fileName: state.file.name,
      pages: rerunPage === null ? pageRangeInput.value.trim() : String(rerunPage),
      fresh: rerunPage !== null,
      signal,
    });

    for await (const event of events) {
      handleEvent(event, { rerunPage });
    }

    markUnfinishedPages("skipped");
    renderActivePage();
    finishStatus();
  } catch (error) {
    markUnfinishedPages("skipped");
    // A stopped re-run should not cost the reader the text they already had.
    if (previousResult && state.pages.get(rerunPage)?.status === "skipped") {
      state.pages.set(rerunPage, previousResult);
      updatePageOption(previousResult);
    }
    renderActivePage();

    if (signal.aborted) {
      setStatus("idle", "Stopped");
    } else if (state.pages.size === 0) {
      setStatus("error", "Error");
      primaryOutput.textContent = error.message;
    } else {
      // Pages that already arrived stay readable. The error explains the rest.
      setStatus("error", "Error");
      pageError.hidden = false;
      pageError.textContent = error.message;
    }
  } finally {
    state.isRunning = false;
    state.abortController = null;
    renderControls();
  }
}

// --- Wiring -----------------------------------------------------------------

fileInput.addEventListener("change", (event) => {
  state.file = event.target.files?.[0] || null;
  fileMeta.textContent = state.file
    ? `${state.file.name} • ${Math.max(1, Math.round(state.file.size / 1024))} KB`
    : "No file selected";
  resetPages();
  setStatus("idle", "Idle");
  updatePreview();
});

pageSelect.addEventListener("change", (event) => setActivePage(Number(event.target.value)));
prevPageButton.addEventListener("click", () => stepPage(-1));
nextPageButton.addEventListener("click", () => stepPage(1));
transcribeButton.addEventListener("click", () => runTranscription());
stopButton.addEventListener("click", () => state.abortController?.abort());
rerunPageButton.addEventListener("click", () =>
  runTranscription({ rerunPage: state.activePageNumber })
);
saveTextButton.addEventListener("click", saveDocument);
saveRawButton.addEventListener("click", saveUncorrectedDocument);
savePageButton.addEventListener("click", () => {
  const page = activePage();
  if (page) {
    savePage(page);
  }
});
window.addEventListener("beforeunload", clearPreview);

setStatus("idle", "Idle");
renderControls();

try {
  await initSettings();
} catch (error) {
  primaryOutput.textContent = error.message;
  setStatus("error", "Error");
}
