import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Every test works in a throwaway data folder, never the real settings.
const dataRoot = mkdtempSync(join(tmpdir(), "handwriting-ocr-test-"));
process.env.APP_DATA_DIR = dataRoot;

const { cacheKey, readCache, writeCache } = await import("../server/cache.js");
const { isTrustedRequest, startServer } = await import("../server/index.js");
const {
  createSseParser,
  describeErrorBody,
  isRetryableStatus,
  retryDelayMs,
  streamChat,
} = await import("../server/openrouter.js");
const { openDocument, parsePageRange } = await import("../server/pdf-pages.js");
const {
  DEFAULT_OCR_PROMPT,
  applySettingsPatch,
  loadSettings,
  publicSettings,
  saveSettings,
  setSecretCodec,
} = await import("../server/settings-store.js");
const { transcribeDocumentPages } = await import("../server/transcription-service.js");
const { createEventQueue, deepMerge, runPool } = await import("../server/util.js");

after(() => rmSync(dataRoot, { recursive: true, force: true }));

function sseResponse(lines, { status = 200, headers = {} } = {}) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    }),
    { status, headers }
  );
}

function deltaLine(text, finishReason = null) {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: finishReason }],
  })}\n\n`;
}

const provider = { baseUrl: "https://example.invalid/api/v1", apiKey: "test-key" };

test("parsePageRange reads single pages, ranges and open ranges", () => {
  assert.deepEqual(parsePageRange("", 3), [1, 2, 3]);
  assert.deepEqual(parsePageRange("2", 5), [2]);
  assert.deepEqual(parsePageRange("4-, 1", 6), [1, 4, 5, 6]);
  assert.deepEqual(parsePageRange("-2,2-3", 5), [1, 2, 3]);
  assert.deepEqual(parsePageRange("3-999999999", 4), [3, 4]);
  assert.throws(() => parsePageRange("abc", 5), /Could not read page range/);
  assert.throws(() => parsePageRange("5-2", 5), /starts after it ends/);
  assert.throws(() => parsePageRange("9", 5), /outside this document/);
});

test("deepMerge overlays nested values and keeps the base for null", () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 5 }, d: [2, 3], e: null });
  assert.deepEqual(merged, { a: { b: 5, c: 2 }, d: [2, 3], e: undefined });
});

test("runPool never exceeds the limit and visits every item", async () => {
  let inFlight = 0;
  let peak = 0;
  const seen = [];

  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    seen.push(item);
    inFlight -= 1;
  });

  assert.equal(peak, 3);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7]);
});

test("createEventQueue delivers events in order and surfaces a failure", async () => {
  const queue = createEventQueue();
  queue.push(1);
  setTimeout(() => {
    queue.push(2);
    queue.close(new Error("boom"));
  }, 5);

  const received = [];
  await assert.rejects(async () => {
    for await (const event of queue) {
      received.push(event);
    }
  }, /boom/);
  assert.deepEqual(received, [1, 2]);
});

test("SSE parser handles split chunks, comments and the done marker", () => {
  const events = [];
  const parser = createSseParser((data) => events.push(data));

  parser.push(': OPENROUTER PROCESSING\n\ndata: {"a"');
  parser.push(':1}\r\n\ndata: not json\n\ndata: [DONE]\n\ndata: {"b":2}');
  parser.flush();

  assert.deepEqual(events, [{ a: 1 }, { b: 2 }]);
});

test("retry policy covers rate limits and server errors only", () => {
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(503), true);
  assert.equal(isRetryableStatus(400), false);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(retryDelayMs(0), 1000);
  assert.equal(retryDelayMs(2), 4000);
  assert.equal(retryDelayMs(0, "7"), 7000);
  assert.equal(retryDelayMs(0, "9999"), 20000);
});

test("describeErrorBody copes with JSON and HTML error pages", () => {
  assert.match(describeErrorBody(402, '{"error":{"message":"No credits"}}'), /No credits/);
  assert.equal(
    describeErrorBody(502, "<html>Bad gateway</html>"),
    "OpenRouter request failed with status 502."
  );
});

test("streamChat streams text and reports the finish reason", async () => {
  const deltas = [];
  const result = await streamChat({
    provider,
    model: "m",
    messages: [],
    onDelta: (text) => deltas.push(text),
    fetchImpl: async () => sseResponse([deltaLine("Lie"), deltaLine("be ", "length")]),
  });

  assert.deepEqual(deltas, ["Lie", "be "]);
  assert.deepEqual(result, { text: "Liebe", finishReason: "length" });
});

test("streamChat retries a rate limit, then succeeds", async () => {
  const waits = [];
  let calls = 0;

  const result = await streamChat({
    provider,
    model: "m",
    messages: [],
    wait: async (ms) => waits.push(ms),
    fetchImpl: async () => {
      calls += 1;
      return calls < 3
        ? new Response('{"error":{"message":"slow down"}}', { status: 429 })
        : sseResponse([deltaLine("ok", "stop")]);
    },
  });

  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.equal(result.text, "ok");
});

test("streamChat does not retry a rejected key", async () => {
  let calls = 0;

  await assert.rejects(
    streamChat({
      provider,
      model: "m",
      messages: [],
      wait: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return new Response('{"error":{"message":"Invalid key"}}', { status: 401 });
      },
    }),
    /Invalid key/
  );
  assert.equal(calls, 1);
});

test("streamChat does not retry once text has been streamed", async () => {
  let calls = 0;

  await assert.rejects(
    streamChat({
      provider,
      model: "m",
      messages: [],
      wait: async () => {},
      fetchImpl: async () => {
        calls += 1;
        return sseResponse([deltaLine("half"), 'data: {"error":{"message":"overloaded"}}\n\n']);
      },
    }),
    /overloaded/
  );
  assert.equal(calls, 1);
});

test("cache keys depend on every part and round-trip through disk", async () => {
  const key = cacheKey("ocr", Buffer.from("page"), "model-a", "prompt");
  assert.notEqual(key, cacheKey("ocr", Buffer.from("page"), "model-b", "prompt"));
  assert.notEqual(key, cacheKey("ocr", Buffer.from("pag"), "emodel-a", "prompt"));
  assert.equal(await readCache(key), null);
  await writeCache(key, { text: "hello" });
  assert.deepEqual(await readCache(key), { text: "hello" });
});

test("settings: key stays server-side, empty key keeps the saved one", () => {
  saveSettings({ providers: { openrouter: { apiKey: "sk-or-secret" } } });
  assert.equal(loadSettings().providers.openrouter.apiKey, "sk-or-secret");

  const visible = publicSettings(loadSettings());
  assert.equal(visible.providers.openrouter.hasApiKey, true);
  assert.equal(JSON.stringify(visible).includes("sk-or-secret"), false);

  saveSettings({
    ocrModel: { model: "vendor/other" },
    providers: { openrouter: { apiKey: "" } },
    pipeline: { ocrConcurrency: 99, correctionEnabled: true },
  });
  const saved = loadSettings();
  assert.equal(saved.providers.openrouter.apiKey, "sk-or-secret");
  assert.equal(saved.ocrModel.model, "vendor/other");
  assert.equal(saved.pipeline.ocrConcurrency, 8);
  assert.equal(saved.pipeline.correctionEnabled, true);
});

test("settings: unedited prompts follow the default and legacy fields are dropped", () => {
  const upgraded = applySettingsPatch(loadSettings(), {
    prompts: {
      ocr: "Transcribe this handwritten document faithfully. The handwriting may be German Suetterlin / Sütterlin. Preserve line breaks where possible, mark uncertain readings in [brackets], and do not summarize.",
    },
    providers: { azureDocumentIntelligence: { enabled: true } },
  });
  assert.equal(upgraded.prompts.ocr, DEFAULT_OCR_PROMPT);
  assert.deepEqual(Object.keys(upgraded.providers), ["openrouter"]);

  saveSettings({ prompts: { ocr: "My own prompt" } });
  assert.equal(loadSettings().prompts.ocr, "My own prompt");
  saveSettings({ prompts: { ocr: DEFAULT_OCR_PROMPT } });
  const onDisk = JSON.parse(readFileSync(join(dataRoot, "data", "settings.json"), "utf8"));
  assert.equal("ocr" in onDisk.prompts, false);
});

test("settings: with a codec the key is encrypted on disk", () => {
  setSecretCodec({
    encrypt: (text) => Buffer.from(`enc:${text}`).toString("base64"),
    decrypt: (encoded) => Buffer.from(encoded, "base64").toString().replace(/^enc:/, ""),
  });

  try {
    saveSettings({ providers: { openrouter: { apiKey: "sk-or-wrapped" } } });
    const raw = readFileSync(join(dataRoot, "data", "settings.json"), "utf8");
    assert.equal(raw.includes("sk-or-wrapped"), false);
    assert.equal(loadSettings().providers.openrouter.apiKey, "sk-or-wrapped");
  } finally {
    setSecretCodec(null);
    saveSettings({ providers: { openrouter: { apiKey: "sk-or-secret" } } });
  }
});

test("isTrustedRequest only accepts the app's own origin", () => {
  assert.equal(isTrustedRequest({ host: "127.0.0.1:3000" }), true);
  assert.equal(
    isTrustedRequest({ host: "localhost:3000", origin: "http://localhost:3000" }),
    true
  );
  assert.equal(
    isTrustedRequest({ host: "127.0.0.1:3000", origin: "https://evil.example" }),
    false
  );
  assert.equal(isTrustedRequest({ host: "evil.example" }), false);
  assert.equal(isTrustedRequest({}), false);
});

test("openDocument splits a PDF lazily into single pages", async () => {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.create();
  source.addPage([200, 200]);
  source.addPage([300, 300]);
  source.addPage([400, 400]);
  const bytes = Buffer.from(await source.save());

  const document = await openDocument(
    { bytes, mimeType: "application/pdf", fileName: "letters.pdf" },
    { pageRange: "2-" }
  );
  assert.equal(document.pageCount, 3);
  assert.deepEqual(document.pages.map((page) => page.pageNumber), [2, 3]);

  const second = await document.pages[0].load();
  assert.equal(second.fileName, "letters-page-2.pdf");
  const reloaded = await PDFDocument.load(second.bytes);
  assert.equal(reloaded.getPageCount(), 1);
  assert.equal(reloaded.getPage(0).getWidth(), 300);
});

// --- Pipeline and HTTP, against a fake OpenRouter ---------------------------

let realFetch;
let modelCalls;

function installFakeOpenRouter() {
  modelCalls = [];
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith("https://openrouter.ai/")) {
      return realFetch(url, init);
    }
    const body = JSON.parse(init.body);
    modelCalls.push(body);
    const isCorrection = typeof body.messages[1].content === "string";
    if (isCorrection) {
      return sseResponse([deltaLine(`fixed(${body.messages[1].content.length})`, "stop")]);
    }
    const label = body.messages[1].content[0].text;
    if (label.includes("page 2 of")) {
      return new Response('{"error":{"message":"Model refused"}}', { status: 400 });
    }
    return sseResponse([deltaLine("Liebe "), deltaLine("Mutter", "stop")]);
  };
}

before(() => {
  realFetch = globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

async function threePagePdf() {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.create();
  for (const size of [210, 220, 230]) {
    source.addPage([size, size]);
  }
  return Buffer.from(await source.save());
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

test("pipeline: one call per page, failures isolated, second run served from cache", async () => {
  installFakeOpenRouter();
  saveSettings({ pipeline: { correctionEnabled: false, ocrConcurrency: 4 } });
  const file = { bytes: await threePagePdf(), mimeType: "application/pdf", fileName: "a.pdf" };

  const events = await collect(transcribeDocumentPages(file, loadSettings()));
  assert.equal(events[0].type, "start");
  assert.deepEqual(events[0].pageNumbers, [1, 2, 3]);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).failedPages, 1);
  assert.equal(modelCalls.length, 3);
  assert.equal(modelCalls[0].stream, true);

  const pages = Object.fromEntries(
    events.filter((event) => event.type === "page").map((event) => [event.page.pageNumber, event.page])
  );
  assert.equal(pages[1].rawTranscription, "Liebe Mutter");
  assert.equal(pages[1].correctedTranscription, "");
  assert.match(pages[2].error, /Model refused/);
  assert.equal(pages[3].error, null);
  assert.ok(events.some((event) => event.type === "page-delta" && event.text === "Liebe "));

  // Extracted PDF pages carry a timestamp, so wait for the clock to move on:
  // the cache must still recognise the page.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  modelCalls.length = 0;
  const again = await collect(transcribeDocumentPages(file, loadSettings()));
  assert.equal(modelCalls.length, 1, "only the failed page is requested again");
  assert.equal(again.find((event) => event.page?.pageNumber === 1).page.cached, true);

  modelCalls.length = 0;
  await collect(transcribeDocumentPages(file, loadSettings(), { pageRange: "1", fresh: true }));
  assert.equal(modelCalls.length, 1, "a fresh run bypasses the cache");
});

test("pipeline: correction runs per page with the previous page as context", async () => {
  installFakeOpenRouter();
  saveSettings({ pipeline: { correctionEnabled: true } });
  const file = { bytes: await threePagePdf(), mimeType: "application/pdf", fileName: "b.pdf" };

  const events = await collect(
    transcribeDocumentPages(file, loadSettings(), { pageRange: "3-", fresh: true })
  );
  const page = events.find((event) => event.type === "page").page;
  assert.equal(page.rawTranscription, "Liebe Mutter");
  assert.match(page.correctedTranscription, /^fixed\(/);

  const correctionCall = modelCalls.find((call) => typeof call.messages[1].content === "string");
  assert.deepEqual(correctionCall.reasoning, { effort: "low" });
  assert.equal(correctionCall.messages[1].content.includes("previous page"), false);

  saveSettings({ pipeline: { correctionEnabled: false } });
});

test("pipeline: an aborted run stops without a done event", async () => {
  installFakeOpenRouter();
  const controller = new AbortController();
  controller.abort();
  const file = { bytes: await threePagePdf(), mimeType: "application/pdf", fileName: "c.pdf" };

  const events = await collect(
    transcribeDocumentPages(file, loadSettings(), { signal: controller.signal, fresh: true })
  );
  assert.deepEqual(events.map((event) => event.type), ["start"]);
  assert.equal(modelCalls.length, 0);
});

test("HTTP: settings hide the key, foreign origins are refused, uploads stream", async () => {
  installFakeOpenRouter();
  const { server, url } = await startServer({ port: 0, open: false, maxPortRetries: 0 });

  try {
    const settings = await (await realFetch(`${url}/api/settings`)).json();
    assert.equal(settings.providers.openrouter.hasApiKey, true);
    assert.equal("apiKey" in settings.providers.openrouter, false);

    const foreign = await realFetch(`${url}/api/settings`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);

    const traversal = await realFetch(`${url}/..%2Fpackage.json`);
    assert.notEqual(traversal.status, 200);

    const response = await realFetch(`${url}/api/transcribe?fileName=scan.png&fresh=1`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from("not really a png"),
    });
    assert.equal(response.status, 200);
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => line.type),
      ["start", "page-delta", "page-delta", "page", "done"]
    );
    assert.equal(lines[3].page.rawTranscription, "Liebe Mutter");
    assert.match(modelCalls.at(-1).messages[1].content[1].image_url.url, /^data:image\/png;base64,/);

    const unsupported = await realFetch(`${url}/api/transcribe?fileName=a.tiff`, {
      method: "POST",
      headers: { "Content-Type": "image/tiff" },
      body: Buffer.from("x"),
    });
    assert.equal(unsupported.status, 400);
    assert.match((await unsupported.json()).details, /Unsupported file type/);
  } finally {
    server.close();
  }
});
