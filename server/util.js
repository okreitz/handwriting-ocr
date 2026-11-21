export function toMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Recursively overlays `override` on `base`. Arrays and scalars are replaced,
// and null/undefined overrides keep the base value.
export function deepMerge(base, override) {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged = { ...base };
    for (const [key, value] of Object.entries(override)) {
      merged[key] = deepMerge(base[key], value);
    }
    return merged;
  }

  return override ?? base;
}

// Runs `worker(item, index)` over `items` with at most `limit` in flight.
// Items are started in order. Resolves once every worker has settled.
export async function runPool(items, limit, worker) {
  let nextIndex = 0;

  const runSlot = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  };

  const slots = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: slots }, runSlot));
}

export function createDeferred() {
  let resolve;
  const promise = new Promise((resolveFn) => {
    resolve = resolveFn;
  });
  return { promise, resolve };
}

// A push-based async iterator, so concurrent workers can feed one stream.
export function createEventQueue() {
  const buffered = [];
  let waiting = null;
  let closed = false;
  let failure = null;

  const wake = () => {
    if (waiting) {
      waiting();
      waiting = null;
    }
  };

  return {
    push(event) {
      if (!closed) {
        buffered.push(event);
        wake();
      }
    },
    close(error) {
      failure = error || null;
      closed = true;
      wake();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buffered.length > 0) {
          yield buffered.shift();
        }
        if (closed) {
          if (failure) {
            throw failure;
          }
          return;
        }
        await new Promise((resolve) => {
          waiting = resolve;
        });
      }
    },
  };
}
