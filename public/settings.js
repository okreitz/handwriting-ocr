import { fetchJson } from "./api.js";
import { state } from "./state.js";

const dialog = document.querySelector("#settings-dialog");
const form = document.querySelector("#settings-form");
const modelsStatus = document.querySelector("#models-status");
const apiKeyHint = document.querySelector("#api-key-hint");
const fields = form.elements;

function createOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function modelLabel(model) {
  const context = model.contextLength
    ? ` • ${Math.round(model.contextLength / 1000)}k`
    : "";
  return `${model.name} (${model.id})${context}`;
}

function matchesSearch(model, query) {
  const needle = query.trim().toLowerCase();
  return !needle || `${model.id} ${model.name}`.toLowerCase().includes(needle);
}

// Fills a model dropdown, keeping the chosen model selectable even when the
// list has not been loaded or the search hides it.
function populateModelSelect(select, models, selected) {
  const options = models.map((model) => createOption(model.id, modelLabel(model)));

  if (selected && !models.some((model) => model.id === selected)) {
    options.unshift(createOption(selected, selected));
  }
  if (options.length === 0) {
    options.push(createOption("", "No models loaded"));
  }

  select.replaceChildren(...options);
  select.value = selected || options[0].value;
}

function syncModelSelects() {
  const visionModels = state.availableModels.filter((model) => model.supportsVision);

  populateModelSelect(
    fields["ocr-model"],
    visionModels.filter((model) => matchesSearch(model, fields["ocr-model-search"].value)),
    fields["ocr-model"].value || state.settings.ocrModel.model
  );
  populateModelSelect(
    fields["correction-model"],
    state.availableModels.filter((model) =>
      matchesSearch(model, fields["correction-model-search"].value)
    ),
    fields["correction-model"].value || state.settings.correctionModel.model
  );
}

function fillForm() {
  const { settings } = state;
  const openrouter = settings.providers.openrouter;

  fields["openrouter-api-key"].value = "";
  fields["openrouter-base-url"].value = openrouter.baseUrl;
  fields["openrouter-app-name"].value = openrouter.appName;
  fields["openrouter-referer"].value = openrouter.referer;
  fields["correction-enabled"].checked = settings.pipeline.correctionEnabled;
  fields["ocr-concurrency"].value = settings.pipeline.ocrConcurrency;
  fields["ocr-model-search"].value = "";
  fields["correction-model-search"].value = "";
  // Clear the dropdowns so the saved models win over a cancelled edit.
  fields["ocr-model"].replaceChildren();
  fields["correction-model"].replaceChildren();
  syncModelSelects();

  apiKeyHint.textContent = openrouter.hasApiKey
    ? "A key is saved. Leave this empty to keep it, or type a new one to replace it."
    : "Create a key at openrouter.ai/keys and paste it here.";
}

// The key field is only sent when something was typed. The saved key never
// leaves the server.
function readForm() {
  return {
    ocrModel: { model: fields["ocr-model"].value },
    correctionModel: { model: fields["correction-model"].value },
    providers: {
      openrouter: {
        baseUrl: fields["openrouter-base-url"].value.trim(),
        apiKey: fields["openrouter-api-key"].value.trim(),
        appName: fields["openrouter-app-name"].value.trim(),
        referer: fields["openrouter-referer"].value.trim(),
      },
    },
    pipeline: {
      correctionEnabled: fields["correction-enabled"].checked,
      ocrConcurrency: Number(fields["ocr-concurrency"].value),
    },
  };
}

async function loadModels({ force = false } = {}) {
  modelsStatus.textContent = "Loading models...";

  try {
    const payload = await fetchJson("/api/models", {
      method: "POST",
      body: { force, settings: readForm() },
    });
    state.availableModels = payload.models || [];
    syncModelSelects();
    modelsStatus.textContent = `${state.availableModels.length} models available.`;
  } catch (error) {
    modelsStatus.textContent = error.message;
  }
}

async function save(event) {
  event.preventDefault();

  try {
    state.settings = await fetchJson("/api/settings", { method: "PUT", body: readForm() });
    dialog.close();
  } catch (error) {
    window.alert(error.message);
  }
}

function openDialog() {
  fillForm();
  dialog.showModal();
}

export async function initSettings() {
  document.querySelector("#open-settings").addEventListener("click", openDialog);
  document.querySelector("#close-settings").addEventListener("click", () => dialog.close());
  document.querySelector("#cancel-settings").addEventListener("click", () => dialog.close());
  document
    .querySelector("#refresh-models")
    .addEventListener("click", () => loadModels({ force: true }));
  fields["ocr-model-search"].addEventListener("input", syncModelSelects);
  fields["correction-model-search"].addEventListener("input", syncModelSelects);
  form.addEventListener("submit", save);

  for (const button of form.querySelectorAll(".preset-button")) {
    button.addEventListener("click", () => {
      fields["ocr-model-search"].value = "";
      fields["ocr-model"].replaceChildren(createOption(button.dataset.model, button.dataset.model));
      syncModelSelects();
    });
  }

  state.settings = await fetchJson("/api/settings");
  fillForm();

  if (state.settings.providers.openrouter.hasApiKey) {
    await loadModels();
  } else {
    // First start: nothing works without a key, so lead the user straight to it.
    dialog.showModal();
  }
}
