import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { deepMerge } from "./util.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

export const DEFAULT_OCR_PROMPT =
  "You are transcribing a scan of a handwritten historical document. The handwriting is most likely German Kurrent or Sütterlin (18th to 20th century), sometimes mixed with Latin script for names and foreign words. Transcribe exactly what is written: keep the original spelling, capitalisation, punctuation and abbreviations, and do not modernise, translate, correct or summarise. Keep the line breaks of the original. Also transcribe headers, dates, addresses and marginal notes, each on its own line where it appears, and any printed text or form fields. Put struck-through words in ~~tildes~~. Mark readings you are unsure of in [square brackets] and words you cannot read as [illegible]. Return only the transcription, with no commentary.";

export const DEFAULT_CORRECTION_PROMPT =
  "You are correcting a transcription of historical German handwriting (Kurrent or Sütterlin). Fix misread characters, word boundaries and obvious recognition errors, but stay faithful to the source: keep the historical spelling, the line breaks and every [bracketed] uncertainty marker, and do not modernise or add text. If you are unsure, keep the original wording. Return only the corrected transcription.";

// Defaults shipped by earlier versions. A stored prompt that still equals one
// of these was never edited, so it is upgraded to the current default.
const LEGACY_PROMPTS = new Set([
  "Transcribe this handwritten document faithfully. The handwriting may be German Suetterlin / Sütterlin. Preserve line breaks where possible, mark uncertain readings in [brackets], and do not summarize.",
  "You are correcting OCR output from historical German handwriting, often Suetterlin / Sütterlin. Improve character recognition, spelling interpretation, and word boundaries, but stay faithful to the source. If uncertain, preserve the original wording and use [unclear]. Return only the corrected transcription.",
]);

export const DEFAULT_SETTINGS = {
  ocrModel: {
    provider: "openrouter",
    model: "google/gemini-4-carbon",
  },
  correctionModel: {
    provider: "openrouter",
    model: "google/gemini-3.8-flash",
  },
  providers: {
    openrouter: {
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      appName: "Handwriting OCR",
      referer: "",
    },
  },
  pipeline: {
    ocrConcurrency: 4,
    correctionEnabled: false,
  },
  prompts: {
    ocr: DEFAULT_OCR_PROMPT,
    correction: DEFAULT_CORRECTION_PROMPT,
  },
};

const MAX_CONCURRENCY = 8;

// Optional { encrypt(text) -> base64, decrypt(base64) -> text }. The desktop
// app injects one backed by the operating system keychain.
let secretCodec = null;

export function setSecretCodec(codec) {
  secretCodec = codec;
}

// Resolved on every call: the desktop app sets APP_DATA_DIR after this module
// has been imported.
export function getDataDir() {
  return join(process.env.APP_DATA_DIR || PROJECT_ROOT, "data");
}

function getSettingsPath() {
  return join(getDataDir(), "settings.json");
}

function readStored() {
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // A damaged settings file should not stop the app from starting.
    return {};
  }
}

function resolvePrompt(stored, fallback) {
  if (typeof stored !== "string" || !stored.trim() || LEGACY_PROMPTS.has(stored)) {
    return fallback;
  }
  return stored;
}

function normalize(settings) {
  const merged = deepMerge(DEFAULT_SETTINGS, settings);
  const openrouter = merged.providers?.openrouter || {};
  const concurrency = Math.floor(Number(merged.pipeline?.ocrConcurrency));

  return {
    ocrModel: {
      provider: "openrouter",
      model: String(merged.ocrModel?.model || DEFAULT_SETTINGS.ocrModel.model),
    },
    correctionModel: {
      provider: "openrouter",
      model: String(
        merged.correctionModel?.model || DEFAULT_SETTINGS.correctionModel.model
      ),
    },
    providers: {
      openrouter: {
        baseUrl: String(
          openrouter.baseUrl || DEFAULT_SETTINGS.providers.openrouter.baseUrl
        ).replace(/\/+$/, ""),
        apiKey: String(openrouter.apiKey || ""),
        appName: String(openrouter.appName || ""),
        referer: String(openrouter.referer || ""),
      },
    },
    pipeline: {
      ocrConcurrency:
        Number.isFinite(concurrency) && concurrency >= 1
          ? Math.min(concurrency, MAX_CONCURRENCY)
          : DEFAULT_SETTINGS.pipeline.ocrConcurrency,
      correctionEnabled: Boolean(merged.pipeline?.correctionEnabled),
    },
    prompts: {
      ocr: resolvePrompt(merged.prompts?.ocr, DEFAULT_OCR_PROMPT),
      correction: resolvePrompt(merged.prompts?.correction, DEFAULT_CORRECTION_PROMPT),
    },
  };
}

function readStoredApiKey(stored) {
  const openrouter = stored.providers?.openrouter || {};

  if (openrouter.apiKeyEncrypted) {
    if (!secretCodec) {
      return "";
    }
    try {
      return secretCodec.decrypt(openrouter.apiKeyEncrypted);
    } catch {
      return "";
    }
  }

  return openrouter.apiKey || "";
}

// Full settings including the API key. For server-side use only.
export function loadSettings() {
  const stored = readStored();
  const settings = normalize(stored);
  settings.providers.openrouter.apiKey = readStoredApiKey(stored);
  return settings;
}

// What the browser is allowed to see: everything except the key itself.
export function publicSettings(settings) {
  const { apiKey, ...openrouter } = settings.providers.openrouter;
  return {
    ...settings,
    providers: { openrouter: { ...openrouter, hasApiKey: Boolean(apiKey) } },
  };
}

// Overlays a patch from the browser. An empty key in the patch means
// "unchanged", because the browser never receives the saved key.
export function applySettingsPatch(current, patch) {
  const next = normalize(deepMerge(current, patch || {}));
  const patchedKey = patch?.providers?.openrouter?.apiKey;
  next.providers.openrouter.apiKey =
    typeof patchedKey === "string" && patchedKey.trim()
      ? patchedKey.trim()
      : current.providers.openrouter.apiKey;
  return next;
}

function toDisk(settings) {
  const { apiKey, ...openrouter } = settings.providers.openrouter;
  const prompts = {};

  // Only customised prompts are stored, so improved defaults reach everyone else.
  if (settings.prompts.ocr !== DEFAULT_OCR_PROMPT) {
    prompts.ocr = settings.prompts.ocr;
  }
  if (settings.prompts.correction !== DEFAULT_CORRECTION_PROMPT) {
    prompts.correction = settings.prompts.correction;
  }

  if (apiKey && secretCodec) {
    openrouter.apiKeyEncrypted = secretCodec.encrypt(apiKey);
  } else {
    openrouter.apiKey = apiKey;
  }

  return { ...settings, providers: { openrouter }, prompts };
}

export function saveSettings(patch) {
  const next = applySettingsPatch(loadSettings(), patch);
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(getSettingsPath(), JSON.stringify(toDisk(next), null, 2));
  return next;
}
