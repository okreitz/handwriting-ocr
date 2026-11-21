import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildHeaders, describeErrorBody } from "./openrouter.js";
import { getDataDir } from "./settings-store.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function formatModelEntry(model) {
  const inputModalities = model?.architecture?.input_modalities || [];

  return {
    id: model.id,
    name: model.name || model.id,
    description: model.description || "",
    contextLength: model.context_length || 0,
    inputModalities,
    supportsVision:
      inputModalities.includes("image") || inputModalities.includes("file"),
  };
}

function cachePath() {
  return join(getDataDir(), "models-cache.json");
}

async function readCachedModels(baseUrl) {
  try {
    const cached = JSON.parse(await readFile(cachePath(), "utf8"));
    const age = Date.now() - Date.parse(cached.fetchedAt);
    if (cached.baseUrl === baseUrl && age >= 0 && age < CACHE_TTL_MS) {
      return cached;
    }
  } catch {
    // No usable cache.
  }
  return null;
}

// The model list has hundreds of entries and rarely changes, so it is kept for
// a day. `force` skips the cache (the "Load models" button).
export async function listModels(settings, { force = false } = {}) {
  const provider = settings.providers.openrouter;

  if (!force) {
    const cached = await readCachedModels(provider.baseUrl);
    if (cached) {
      return { fetchedAt: cached.fetchedAt, models: cached.models, cached: true };
    }
  }

  const response = await fetch(`${provider.baseUrl}/models`, {
    headers: buildHeaders(provider),
    signal: AbortSignal.timeout(30_000),
  });
  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(describeErrorBody(response.status, bodyText));
  }

  const data = JSON.parse(bodyText);
  const models = Array.isArray(data?.data) ? data.data.map(formatModelEntry) : [];
  models.sort((left, right) => left.name.localeCompare(right.name));

  const result = { baseUrl: provider.baseUrl, fetchedAt: new Date().toISOString(), models };
  try {
    await mkdir(getDataDir(), { recursive: true });
    await writeFile(cachePath(), JSON.stringify(result));
  } catch {
    // Listing still works without the cache file.
  }

  return { fetchedAt: result.fetchedAt, models, cached: false };
}
