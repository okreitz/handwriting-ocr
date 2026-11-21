function localServerError() {
  return `Could not reach the local app server at ${window.location.origin}. If the terminal shows a different localhost port, open that URL and reload.`;
}

async function readErrorMessage(response) {
  const payload = await response.json().catch(() => null);
  return (
    payload?.details ||
    payload?.error ||
    `Request failed with status ${response.status}.`
  );
}

export async function fetchJson(url, { method = "GET", body } = {}) {
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(localServerError());
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return response.json();
}

// The server streams one JSON object per line so text can be shown as it lands.
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
    // Leaving the loop early would otherwise keep the response open.
    await reader.cancel().catch(() => {});
  }
}

// Uploads the document as the raw request body and yields progress events.
export async function* transcribe({ body, mimeType, fileName, pages, fresh, signal }) {
  const query = new URLSearchParams({ fileName, pages: pages || "" });
  if (fresh) {
    query.set("fresh", "1");
  }

  let response;
  try {
    response = await fetch(`/api/transcribe?${query}`, {
      method: "POST",
      headers: { "Content-Type": mimeType },
      body,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    throw new Error(localServerError());
  }

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  yield* readNdjsonStream(response);
}
