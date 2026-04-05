const state = {
  file: null,
  settings: null,
  isRunning: false,
};

const fileInput = document.querySelector("#file-input");
const transcribeButton = document.querySelector("#transcribe-button");
const fileMeta = document.querySelector("#file-meta");
const correctedOutput = document.querySelector("#corrected-output");
const rawOutput = document.querySelector("#raw-output");
const statusPill = document.querySelector("#status-pill");
const saveTextButton = document.querySelector("#save-text-button");
const saveRawButton = document.querySelector("#save-raw-button");
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
    previewFrame.src = state.previewUrl;
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

function updateFileUI() {
  const hasCorrectedText =
    correctedOutput.textContent &&
    correctedOutput.textContent !== "Your transcription will appear here." &&
    correctedOutput.textContent !== "Running correction pipeline...";
  const hasRawText =
    rawOutput.textContent &&
    rawOutput.textContent !== "The raw OCR output will appear here." &&
    rawOutput.textContent !== "Running OCR..." &&
    rawOutput.textContent !== "No OCR output available.";

  if (!state.file) {
    fileMeta.textContent = "No file selected";
    transcribeButton.disabled = true;
    updatePreview();
    saveTextButton.disabled = !hasCorrectedText;
    saveRawButton.disabled = !hasRawText;
    return;
  }

  const sizeKb = Math.round(state.file.size / 1024);
  fileMeta.textContent = `${state.file.name} • ${sizeKb} KB`;
  transcribeButton.disabled = state.isRunning;
  saveTextButton.disabled = !hasCorrectedText;
  saveRawButton.disabled = !hasRawText;
  updatePreview();
}

function buildTextFileName(suffix = "transcription") {
  const originalName = state.file?.name || "transcription";
  const baseName = originalName.replace(/\.[^.]+$/, "");
  return `${baseName}-${suffix}.txt`;
}

function saveCorrectedText() {
  saveTextBlob(correctedOutput.textContent?.trim(), buildTextFileName());
}

function saveRawText() {
  saveTextBlob(rawOutput.textContent?.trim(), buildTextFileName("raw-ocr"));
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

async function runTranscription() {
  if (!state.file || state.isRunning) {
    return;
  }

  state.isRunning = true;
  transcribeButton.disabled = true;
  correctedOutput.textContent = "Running correction pipeline...";
  rawOutput.textContent = "Running OCR...";
  setStatus("running", "Running");

  try {
    const base64 = await fileToBase64(state.file);
    const payload = await fetchJson("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileName: state.file.name,
        mimeType: state.file.type || "application/octet-stream",
        base64,
      }),
    });

    rawOutput.textContent = payload.rawTranscription || "";
    correctedOutput.textContent = payload.correctedTranscription || "";
    setStatus("done", "Done");
    saveTextButton.disabled = false;
    saveRawButton.disabled = false;
  } catch (error) {
    correctedOutput.textContent = error.message;
    rawOutput.textContent = "No OCR output available.";
    setStatus("error", "Error");
    saveTextButton.disabled = true;
    saveRawButton.disabled = true;
  } finally {
    state.isRunning = false;
    updateFileUI();
  }
}

fileInput.addEventListener("change", (event) => {
  state.file = event.target.files?.[0] || null;
  updateFileUI();
});

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
