import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SETTINGS_PATH = join(
  process.env.APP_DATA_DIR || process.cwd(),
  "data",
  "settings.json"
);

const DEFAULT_SETTINGS = {
  ocrModel: {
    provider: "openrouter",
    model: "google/gemini-2.5-flash-preview",
  },
  correctionModel: {
    provider: "openrouter",
    model: "openai/gpt-5-mini",
  },
  providers: {
    openrouter: {
      enabled: true,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "",
      appName: "Handwriting OCR",
      referer: "",
    },
    azureDocumentIntelligence: {
      enabled: false,
      endpoint: "",
      apiKey: "",
    },
    googleDocumentAi: {
      enabled: false,
      projectId: "",
      location: "",
      processorId: "",
      apiKey: "",
    },
  },
  prompts: {
    ocr:
      "Transcribe this handwritten document faithfully. The handwriting may be German Suetterlin / Sütterlin. Preserve line breaks where possible, mark uncertain readings in [brackets], and do not summarize.",
    correction:
      "You are correcting OCR output from historical German handwriting, often Suetterlin / Sütterlin. Improve character recognition, spelling interpretation, and word boundaries, but stay faithful to the source. If uncertain, preserve the original wording and use [unclear]. Return only the corrected transcription.",
  },
};

function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override ?? base;
  }

  if (
    base &&
    typeof base === "object" &&
    override &&
    typeof override === "object"
  ) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = deepMerge(base[key], value);
    }
    return merged;
  }

  return override ?? base;
}

function ensureSettingsFile() {
  const dir = dirname(SETTINGS_PATH);
  mkdirSync(dir, { recursive: true });

  if (!existsSync(SETTINGS_PATH)) {
    writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
  }
}

export function loadSettings() {
  ensureSettingsFile();

  const raw = readFileSync(SETTINGS_PATH, "utf8");
  const parsed = JSON.parse(raw);
  return deepMerge(DEFAULT_SETTINGS, parsed);
}

export function saveSettings(nextSettings) {
  ensureSettingsFile();
  const merged = deepMerge(DEFAULT_SETTINGS, nextSettings);
  writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}
