import { setTimeout as sleep } from "node:timers/promises";

const IDLE_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 20_000;

export function buildHeaders(provider) {
  if (!provider?.apiKey) {
    throw new Error("OpenRouter API key is missing. Add it in Settings.");
  }

  return {
    Authorization: `Bearer ${provider.apiKey}`,
    "Content-Type": "application/json",
    ...(provider.referer ? { "HTTP-Referer": provider.referer } : {}),
    ...(provider.appName ? { "X-Title": provider.appName } : {}),
  };
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

// Exponential backoff (1s, 2s, 4s) unless the server names a wait itself.
export function retryDelayMs(attempt, retryAfterSeconds) {
  const requested = Number(retryAfterSeconds);
  const base =
    Number.isFinite(requested) && requested > 0
      ? requested * 1000
      : 1000 * 2 ** attempt;
  return Math.min(base, MAX_RETRY_DELAY_MS);
}

// Turns an error response into a readable message. Gateways sometimes answer
// with HTML, so the body is not assumed to be JSON.
export function describeErrorBody(status, bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message || parsed?.message;
    if (message) {
      return `OpenRouter request failed (${status}): ${message}`;
    }
  } catch {
    // Not JSON.
  }
  return `OpenRouter request failed with status ${status}.`;
}

// Incremental parser for a server-sent-event stream. Calls `onData` with each
// parsed JSON payload. Comment lines (keep-alives) and "[DONE]" are skipped.
export function createSseParser(onData) {
  let buffer = "";

  const handleLine = (line) => {
    if (!line.startsWith("data:")) {
      return;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    onData(parsed);
  };

  return {
    push(text) {
      buffer += text;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        handleLine(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.trim()) {
        handleLine(buffer.trim());
      }
      buffer = "";
    },
  };
}

function contentToText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((item) => item?.text || "").join("");
  }
  return "";
}

function retryableError(message, extra = {}) {
  return Object.assign(new Error(message), { retryable: true, ...extra });
}

async function streamOnce({ provider, body, signal, onDelta, fetchImpl }) {
  const controller = new AbortController();
  let timedOut = false;
  let idleTimer = null;

  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };
  const forwardAbort = () => controller.abort();
  signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    armIdleTimer();
    const response = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(provider),
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      throw Object.assign(new Error(describeErrorBody(response.status, bodyText)), {
        retryable: isRetryableStatus(response.status),
        retryAfter: response.headers.get("retry-after"),
      });
    }

    let text = "";
    let finishReason = null;
    let streamError = null;

    const parser = createSseParser((data) => {
      if (data.error) {
        streamError = data.error.message || "The model stopped with an error.";
        return;
      }
      const choice = data.choices?.[0];
      if (!choice) {
        return;
      }
      const delta = contentToText(choice.delta?.content ?? choice.message?.content);
      if (delta) {
        text += delta;
        onDelta?.(delta);
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    });

    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      armIdleTimer();
      parser.push(decoder.decode(chunk, { stream: true }));
      if (streamError) {
        break;
      }
    }
    parser.flush();

    if (streamError) {
      throw retryableError(`OpenRouter request failed: ${streamError}`);
    }

    return { text: text.trim(), finishReason };
  } catch (error) {
    if (signal?.aborted) {
      throw new Error("Transcription was stopped.");
    }
    if (timedOut) {
      throw retryableError("The model did not respond in time.");
    }
    if (error?.retryable === undefined) {
      // fetch itself failed: DNS, dropped connection and similar.
      throw retryableError(`Could not reach OpenRouter: ${error?.message || error}`);
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

// Sends one chat completion and streams the answer through `onDelta`.
// Retries rate limits and server errors, but only while nothing has been
// streamed yet, so the caller never sees duplicated text.
export async function streamChat({
  provider,
  model,
  messages,
  reasoningEffort,
  signal,
  onDelta,
  fetchImpl = fetch,
  wait = sleep,
}) {
  const body = JSON.stringify({
    model,
    messages,
    stream: true,
    ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
  });

  for (let attempt = 0; ; attempt += 1) {
    let emitted = false;

    try {
      return await streamOnce({
        provider,
        body,
        signal,
        fetchImpl,
        onDelta: (delta) => {
          emitted = true;
          onDelta?.(delta);
        },
      });
    } catch (error) {
      if (signal?.aborted || emitted || !error.retryable || attempt >= MAX_RETRIES) {
        throw error;
      }
      await wait(retryDelayMs(attempt, error.retryAfter));
    }
  }
}
