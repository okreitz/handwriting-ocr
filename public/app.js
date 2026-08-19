const state = {
  file: null,
  settings: null,
  isRunning: false,
  pages: [],
  pageCount: 0,
  pageNumbers: [],
  activePageNumber: null,
  previewUrl: null,
};

const fileInput = document.querySelector("#file-input");
const transcribeButton = document.querySelector("#transcribe-button");
const fileMeta = document.querySelector("#file-meta");
const correctedOutput = document.querySelector("#corrected-output");
const rawOutput = document.querySelector("#raw-output");
const statusPill = document.querySelector("#status-pill");
const saveTextButton = document.querySelector("#save-text-button");
const saveRawButton = document.querySelector("#save-raw-button");
const savePageButton = document.querySelector("#save-page-button");
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
const settingsDialog = document.querySelector("#settings-dialog");
const settingsForm = document.querySelector("#settings-form");
const openSettingsButton = document.querySelector("#open-settings");
const closeSettingsButton = document.querySelector("#close-settings");
const cancelSettingsButton = document.querySelector("#cancel-settings");
const refreshModelsButton = document.querySelector("#refresh-models");
const modelsStatus = document.querySelector("#models-status");

const ocrProviderField = settingsForm.elements["ocr-provider"];
const correctionProviderField = settingsForm.elements["correction-provider"];
const ocrModelField = settingsForm.elements["ocr-model"];
const correctionModelField = settingsForm.elements["correction-model"];
const ocrModelSearchField = settingsForm.elements["ocr-model-search"];
const correctionModelSearchField = settingsForm.elements["correction-model-search"];

function buildLocalServerError() {
  return `Could not reach the local app server at ${window.location.origin}. If the terminal shows a different localhost port, open that URL and reload.`;
}

async function fetchJson(url, options = {}) {
  let response;

  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(buildLocalServerError());
  }

  let payload = null;
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    payload = await response.json();
  } else {
    const text = await response.text();
    payload = text ? { error: text } : null;
  }

  if (!response.ok) {
    throw new Error(
      payload?.details ||
        payload?.error ||
        `Request failed with status ${response.status}.`
    );
  }

  return payload;
}

function setStatus(kind, label) {
  statusPill.className = `status-pill ${kind}`;
  statusPill.textContent = label;
}

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

  state.previewUrl = URL.createObjectURL(state.file);
  previewMeta.textContent = state.file.type === "application/pdf" ? "PDF preview" : "Image preview";

  if (state.file.type === "application/pdf") {
    previewFrame.src = `${state.previewUrl}#page=1`;
    previewFrame.hidden = false;
    previewPlaceholder.hidden = true;
    documentPreview.classList.remove("empty");
    return;
  }

  if (state.file.type.startsWith("image/")) {
    previewImage.src = state.previewUrl;
    previewImage.hidden = false;
    previewPlaceholder.hidden = true;
    documentPreview.classList.remove("empty");
    return;
  }

  previewMeta.textContent = "Preview unavailable for this file type";
}

// Keeps the original document on the same page the transcription panel shows.
function syncPreviewPage(pageNumber) {
  if (!state.previewUrl || state.file?.type !== "application/pdf" || !pageNumber) {
    return;
  }

  previewFrame.src = `${state.previewUrl}#page=${pageNumber}`;
  previewMeta.textContent =
    state.pageCount > 1
      ? `PDF preview • page ${pageNumber} of ${state.pageCount}`
      : "PDF preview";
}

function findPage(pageNumber) {
  return state.pages.find((page) => page.pageNumber === pageNumber) || null;
}

function resetPages() {
  state.pages = [];
  state.pageCount = 0;
  state.pageNumbers = [];
  state.activePageNumber = null;
  pageNav.hidden = true;
  pageSelect.innerHTML = "";
  pageProgress.textContent = "";
  pageError.hidden = true;
  pageError.textContent = "";
  updateSaveButtons();
}

function updateSaveButtons() {
  const hasPages = state.pages.length > 0;
  saveTextButton.disabled = !hasPages;
  saveRawButton.disabled = !hasPages;
  savePageButton.disabled = !findPage(state.activePageNumber);
}

function renderPageNav() {
  const total = state.pageNumbers.length;
  pageNav.hidden = total <= 1;

  if (total === 0) {
    pageSelect.innerHTML = "";
    pageProgress.textContent = "";
    return;
  }

  pageSelect.innerHTML = "";
  for (const pageNumber of state.pageNumbers) {
    const page = findPage(pageNumber);
    const label = !page
      ? `Page ${pageNumber} — pending`
      : page.error
        ? `Page ${pageNumber} — failed`
        : `Page ${pageNumber}`;
    const option = createOption(String(pageNumber), label);
    option.disabled = !page;
    pageSelect.append(option);
  }

  if (state.activePageNumber !== null) {
    pageSelect.value = String(state.activePageNumber);
  }

  pageProgress.textContent = `${state.pages.length} of ${total} pages transcribed`;

  const index = state.pageNumbers.indexOf(state.activePageNumber);
  prevPageButton.disabled = index <= 0;
  nextPageButton.disabled =
    index < 0 || index >= total - 1 || !findPage(state.pageNumbers[index + 1]);
}

function renderActivePage() {
  const page = findPage(state.activePageNumber);

  if (!page) {
    pageError.hidden = true;
    pageError.textContent = "";
    return;
  }

  if (page.error) {
    pageError.hidden = false;
    pageError.textContent = `Page ${page.pageNumber} failed: ${page.error}`;
  } else {
    pageError.hidden = true;
    pageError.textContent = "";
  }

  correctedOutput.textContent =
    page.correctedTranscription ||
    (page.error ? "No corrected text for this page." : "This page came back empty.");
  rawOutput.textContent =
    page.rawTranscription ||
    (page.error ? "No OCR output for this page." : "This page came back empty.");
}

function setActivePage(pageNumber) {
  if (!findPage(pageNumber)) {
    return;
  }

  state.activePageNumber = pageNumber;
  renderActivePage();
  renderPageNav();
  updateSaveButtons();
  syncPreviewPage(pageNumber);
}

function stepPage(offset) {
  const index = state.pageNumbers.indexOf(state.activePageNumber);
  if (index < 0) {
    return;
  }

  setActivePage(state.pageNumbers[index + offset]);
}

function updateFileUI({ refreshPreview = true } = {}) {
  if (!state.file) {
    fileMeta.textContent = "No file selected";
    transcribeButton.disabled = true;
  } else {
    const sizeKb = Math.round(state.file.size / 1024);
    fileMeta.textContent = `${state.file.name} • ${sizeKb} KB`;
    transcribeButton.disabled = state.isRunning;
  }

  updateSaveButtons();

  if (refreshPreview) {
    updatePreview();
  }
}

function buildTextFileName(suffix = "transcription") {
  const originalName = state.file?.name || "transcription";
  const baseName = originalName.replace(/\.[^.]+$/, "");
  return `${baseName}-${suffix}.txt`;
}

function pageBodyText(page, key) {
  if (page.error) {
    return `[Transcription failed: ${page.error}]`;
  }

  return (page[key] || "").trim();
}

function buildDocumentText(key) {
  if (state.pages.length === 0) {
    return "";
  }

  if (state.pageCount <= 1) {
    return pageBodyText(state.pages[0], key);
  }

  return state.pages
    .map((page) => `--- Page ${page.pageNumber} ---\n\n${pageBodyText(page, key)}`)
    .join("\n\n");
}

function saveCorrectedText() {
  saveTextBlob(buildDocumentText("correctedTranscription"), buildTextFileName());
}

function saveRawText() {
  saveTextBlob(buildDocumentText("rawTranscription"), buildTextFileName("raw-ocr"));
}

function saveCurrentPageText() {
  const page = findPage(state.activePageNumber);
  if (!page) {
    return;
  }

  saveTextBlob(
    pageBodyText(page, "correctedTranscription"),
    buildTextFileName(`page-${page.pageNumber}`)
  );
}

function saveTextBlob(text, fileName) {
  if (!text) {
    return;
  }

  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const downloadUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = downloadUrl;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(downloadUrl);
}

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function buildModelLabel(model) {
  const tags = [];
  if (model.supportsVision) {
    tags.push("vision");
  }
  if (model.contextLength) {
    tags.push(`${Math.round(model.contextLength / 1000)}k`);
  }

  return tags.length > 0
    ? `${model.name} (${model.id}) • ${tags.join(" • ")}`
    : `${model.name} (${model.id})`;
}

function populateModelSelect(select, models, selectedValue, fallbackLabel) {
  select.innerHTML = "";

  if (!models.length) {
    select.append(createOption(selectedValue || "", fallbackLabel));
    select.value = selectedValue || "";
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const model of models) {
    fragment.append(createOption(model.id, buildModelLabel(model)));
  }

  select.append(fragment);

  const hasSelectedValue = models.some((model) => model.id === selectedValue);
  if (!hasSelectedValue && selectedValue) {
    select.prepend(createOption(selectedValue, `${selectedValue} (saved)`));
  }

  select.value = selectedValue || models[0].id;
}

function getModelsForProvider(providerName) {
  const models = state.availableModels?.[providerName] || [];
  return [...models];
}

function filterModels(models, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return models;
  }

  return models.filter((model) => {
    const haystack = [
      model.id,
      model.name,
      model.description,
      ...(model.inputModalities || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return haystack.includes(normalized);
  });
}

function syncModelSelects() {
  const ocrModels = filterModels(
    getModelsForProvider(ocrProviderField.value),
    ocrModelSearchField.value
  );
  const correctionModels = filterModels(
    getModelsForProvider(correctionProviderField.value),
    correctionModelSearchField.value
  );
  const selectedOcrModel = ocrModelField.value || state.settings?.ocrModel?.model;
  const selectedCorrectionModel =
    correctionModelField.value || state.settings?.correctionModel?.model;

  populateModelSelect(
    ocrModelField,
    ocrModels,
    selectedOcrModel,
    "No models loaded for this provider"
  );
  populateModelSelect(
    correctionModelField,
    correctionModels,
    selectedCorrectionModel,
    "No models loaded for this provider"
  );
}

function fillSettingsForm(settings) {
  ocrProviderField.value = settings.ocrModel.provider;
  correctionProviderField.value = settings.correctionModel.provider;
  settingsForm.elements["openrouter-enabled"].checked = settings.providers.openrouter.enabled;
  settingsForm.elements["openrouter-base-url"].value = settings.providers.openrouter.baseUrl;
  settingsForm.elements["openrouter-api-key"].value = settings.providers.openrouter.apiKey;
  settingsForm.elements["openrouter-app-name"].value = settings.providers.openrouter.appName;
  settingsForm.elements["openrouter-referer"].value = settings.providers.openrouter.referer;
  syncModelSelects();
}

function readSettingsForm() {
  return {
    ...state.settings,
    ocrModel: {
      provider: ocrProviderField.value,
      model: ocrModelField.value,
    },
    correctionModel: {
      provider: correctionProviderField.value,
      model: correctionModelField.value,
    },
    providers: {
      ...state.settings.providers,
      openrouter: {
        enabled: settingsForm.elements["openrouter-enabled"].checked,
        baseUrl: settingsForm.elements["openrouter-base-url"].value.trim(),
        apiKey: settingsForm.elements["openrouter-api-key"].value.trim(),
        appName: settingsForm.elements["openrouter-app-name"].value.trim(),
        referer: settingsForm.elements["openrouter-referer"].value.trim(),
      },
    },
  };
}

async function loadModels(providerName, { silent = false } = {}) {
  if (!silent) {
    modelsStatus.textContent = "Loading models...";
  }

  const payload = await fetchJson("/api/models", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      provider: providerName,
      settings: readSettingsForm(),
    }),
  });

  state.availableModels = {
    ...(state.availableModels || {}),
    [providerName]: payload.models || [],
  };

  if (!silent) {
    const count = payload.models?.length || 0;
    modelsStatus.textContent = `Loaded ${count} models from ${providerName}.`;
  }
}

async function loadSettings() {
  state.settings = await fetchJson("/api/settings");
  state.availableModels = {};
  fillSettingsForm(state.settings);

  if (state.settings.providers.openrouter.apiKey) {
    try {
      await loadModels("openrouter", { silent: true });
      syncModelSelects();
      modelsStatus.textContent = `Loaded ${state.availableModels.openrouter.length} models from openrouter.`;
    } catch (error) {
      modelsStatus.textContent = error.message;
    }
  }
}

async function saveSettings(event) {
  event.preventDefault();

  const nextSettings = readSettingsForm();
  const payload = await fetchJson("/api/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(nextSettings),
  });

  state.settings = payload;
  settingsDialog.close();
}

async function fileToBase64(file) {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

// The server streams one JSON object per line so pages can be shown as they land.
async function* readNdjsonStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          yield JSON.parse(line);
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }

    const tail = buffer.trim();
    if (tail) {
      yield JSON.parse(tail);
    }
  } finally {
    // Leaving the loop early (an error event) would otherwise keep the response open.
    await reader.cancel().catch(() => {});
  }
}

function describeProgress() {
  const total = state.pageNumbers.length;
  return total > 1 ? `Running ${state.pages.length}/${total}` : "Running";
}

function handleTranscriptionEvent(event) {
  if (event.type === "start") {
    state.pageCount = event.pageCount;
    state.pageNumbers = event.pageNumbers || [];
    renderPageNav();
    setStatus("running", describeProgress());
    return;
  }

  if (event.type === "page") {
    state.pages.push(event.page);

    // Land on the first finished page, but never yank the reader off the page
    // they are currently on as later ones arrive.
    if (state.activePageNumber === null) {
      setActivePage(event.page.pageNumber);
    } else if (state.activePageNumber === event.page.pageNumber) {
      renderActivePage();
    }

    renderPageNav();
    updateSaveButtons();
    setStatus("running", describeProgress());
    return;
  }

  if (event.type === "error") {
    throw new Error(event.details || event.error || "Transcription failed.");
  }
}

async function runTranscription() {
  if (!state.file || state.isRunning) {
    return;
  }

  state.isRunning = true;
  transcribeButton.disabled = true;
  resetPages();
  correctedOutput.textContent = "Running correction pipeline...";
  rawOutput.textContent = "Running OCR...";
  setStatus("running", "Running");

  try {
    const base64 = await fileToBase64(state.file);
    let response;

    try {
      response = await fetch("/api/transcribe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fileName: state.file.name,
          mimeType: state.file.type || "application/octet-stream",
          base64,
          pageRange: pageRangeInput.value.trim(),
        }),
      });
    } catch (error) {
      throw new Error(buildLocalServerError());
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(
        payload?.details ||
          payload?.error ||
          `Request failed with status ${response.status}.`
      );
    }

    for await (const event of readNdjsonStream(response)) {
      handleTranscriptionEvent(event);
    }

    if (state.pages.length === 0) {
      throw new Error("The transcription finished without returning any pages.");
    }

    const failedPages = state.pages.filter((page) => page.error).length;
    if (failedPages === state.pages.length) {
      setStatus("error", "Error");
    } else if (failedPages > 0) {
      setStatus("done", `Done • ${failedPages} failed`);
    } else {
      setStatus("done", "Done");
    }
  } catch (error) {
    // Pages that already arrived stay readable; the error explains the rest.
    if (state.pages.length === 0) {
      correctedOutput.textContent = error.message;
      rawOutput.textContent = "No OCR output available.";
    } else {
      pageError.hidden = false;
      pageError.textContent = error.message;
    }
    setStatus("error", "Error");
  } finally {
    state.isRunning = false;
    updateFileUI({ refreshPreview: false });
  }
}

fileInput.addEventListener("change", (event) => {
  state.file = event.target.files?.[0] || null;
  resetPages();
  correctedOutput.textContent = "Your transcription will appear here.";
  rawOutput.textContent = "The raw OCR output will appear here.";
  setStatus("idle", "Idle");
  updateFileUI();
});

pageSelect.addEventListener("change", (event) => {
  setActivePage(Number(event.target.value));
});
prevPageButton.addEventListener("click", () => stepPage(-1));
nextPageButton.addEventListener("click", () => stepPage(1));

window.addEventListener("beforeunload", clearPreview);

transcribeButton.addEventListener("click", runTranscription);
openSettingsButton.addEventListener("click", () => settingsDialog.showModal());
closeSettingsButton.addEventListener("click", () => settingsDialog.close());
cancelSettingsButton.addEventListener("click", () => settingsDialog.close());
ocrProviderField.addEventListener("change", syncModelSelects);
correctionProviderField.addEventListener("change", syncModelSelects);
ocrModelSearchField.addEventListener("input", syncModelSelects);
correctionModelSearchField.addEventListener("input", syncModelSelects);
refreshModelsButton.addEventListener("click", async () => {
  try {
    await loadModels("openrouter");
    syncModelSelects();
  } catch (error) {
    modelsStatus.textContent = error.message;
  }
});
saveTextButton.addEventListener("click", saveCorrectedText);
saveRawButton.addEventListener("click", saveRawText);
savePageButton.addEventListener("click", saveCurrentPageText);
settingsForm.addEventListener("submit", async (event) => {
  try {
    await saveSettings(event);
  } catch (error) {
    window.alert(error.message);
  }
});

try {
  await loadSettings();
  updateFileUI();
  setStatus("idle", "Idle");
} catch (error) {
  correctedOutput.textContent = error.message;
  rawOutput.textContent = "The app could not load its settings.";
  modelsStatus.textContent = error.message;
  setStatus("error", "Error");
}
