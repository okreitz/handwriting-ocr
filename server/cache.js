import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getDataDir } from "./settings-store.js";

// Stable key over everything that determines a model answer: the page bytes,
// the model and the prompt. Parts may be strings or Buffers.
export function cacheKey(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function cachePath(key) {
  return join(getDataDir(), "cache", `${key}.json`);
}

export async function readCache(key) {
  try {
    return JSON.parse(await readFile(cachePath(key), "utf8"));
  } catch {
    return null;
  }
}

export async function writeCache(key, value) {
  try {
    await mkdir(join(getDataDir(), "cache"), { recursive: true });
    await writeFile(cachePath(key), JSON.stringify(value));
  } catch {
    // The cache is a convenience. A read-only disk must not fail the page.
  }
}
