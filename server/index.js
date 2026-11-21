import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { listModels } from "./models-service.js";
import {
  applySettingsPatch,
  loadSettings,
  publicSettings,
  saveSettings,
} from "./settings-store.js";
import { transcribeDocumentPages } from "./transcription-service.js";
import { toMessage } from "./util.js";

const HOST = "127.0.0.1";
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 300 * 1024 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

// The server holds an API key and spends money on request, so it only answers
// the app itself. Checking Host stops DNS rebinding, and checking Origin stops
// other websites from posting to it through the user's browser.
export function isTrustedRequest(headers) {
  let hostUrl;
  try {
    hostUrl = new URL(`http://${headers.host}`);
  } catch {
    return false;
  }

  if (!ALLOWED_HOSTNAMES.has(hostUrl.hostname)) {
    return false;
  }

  if (!headers.origin) {
    return true;
  }

  try {
    return new URL(headers.origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

async function readBody(request, maxBytes) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("The upload is too large.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const body = await readBody(request, MAX_JSON_BYTES);
  return body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
}

async function serveStatic(url, response) {
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = join(PUBLIC_DIR, normalize(decodeURIComponent(requestPath)));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let body;
  try {
    if ((await stat(filePath)).isDirectory()) {
      throw new Error("Is a directory");
    }
    body = await readFile(filePath);
  } catch {
    sendText(response, 404, "Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  response.end(body);
}

async function handleApi(url, request, response) {
  if (url.pathname === "/api/settings" && request.method === "GET") {
    sendJson(response, 200, publicSettings(loadSettings()));
    return true;
  }

  if (url.pathname === "/api/settings" && request.method === "PUT") {
    try {
      const settings = saveSettings(await readJsonBody(request));
      sendJson(response, 200, publicSettings(settings));
    } catch (error) {
      sendJson(response, 400, {
        error: "Could not save settings.",
        details: toMessage(error),
      });
    }
    return true;
  }

  if (url.pathname === "/api/models" && request.method === "POST") {
    try {
      const payload = await readJsonBody(request);
      // Unsaved form values are applied on top, so a freshly typed key can be
      // tested before it is saved.
      const settings = applySettingsPatch(loadSettings(), payload.settings);
      sendJson(response, 200, await listModels(settings, { force: Boolean(payload.force) }));
    } catch (error) {
      sendJson(response, 400, {
        error: "Could not load models.",
        details: toMessage(error),
      });
    }
    return true;
  }

  if (url.pathname === "/api/transcribe" && request.method === "POST") {
    await handleTranscribe(url, request, response);
    return true;
  }

  return false;
}

// The document arrives as the raw request body. The answer is newline-delimited
// JSON so text reaches the UI while the models are still working.
async function handleTranscribe(url, request, response) {
  const abortController = new AbortController();
  let finished = false;
  let headersSent = false;

  // If the window is closed or the user presses Stop, stop paying for pages.
  response.on("close", () => {
    if (!finished) {
      abortController.abort();
    }
  });

  const writeEvent = (event) => {
    if (!headersSent) {
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      headersSent = true;
    }
    response.write(`${JSON.stringify(event)}\n`);
  };

  try {
    const file = {
      bytes: await readBody(request, MAX_UPLOAD_BYTES),
      mimeType: (request.headers["content-type"] || "").split(";")[0].trim(),
      fileName: url.searchParams.get("fileName") || "document",
    };

    for await (const event of transcribeDocumentPages(file, loadSettings(), {
      pageRange: url.searchParams.get("pages") || "",
      fresh: url.searchParams.get("fresh") === "1",
      signal: abortController.signal,
    })) {
      if (abortController.signal.aborted) {
        break;
      }
      writeEvent(event);
    }
  } catch (error) {
    if (!abortController.signal.aborted) {
      const details = toMessage(error);
      // Once streaming has started the status code is committed, so the
      // failure has to travel as a final event instead.
      if (headersSent) {
        writeEvent({ type: "error", error: "Transcription failed.", details });
      } else {
        sendJson(response, 400, { error: "Transcription failed.", details });
      }
    }
  } finally {
    finished = true;
    if (!response.writableEnded) {
      response.end();
    }
  }
}

function openBrowser(url) {
  const platform = process.platform;
  if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }

  if (platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    return;
  }

  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

function createAppServer() {
  return createServer(async (request, response) => {
    try {
      if (!request.url || !isTrustedRequest(request.headers)) {
        sendText(response, 403, "Forbidden");
        return;
      }

      const url = new URL(request.url, `http://${request.headers.host}`);

      if (url.pathname.startsWith("/api/")) {
        if (!(await handleApi(url, request, response))) {
          sendText(response, 404, "Not found");
        }
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method not allowed");
        return;
      }

      await serveStatic(url, response);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, 500, {
        error: "Unexpected server error.",
        details: toMessage(error),
      });
    }
  });
}

export async function startServer({
  port = Number(process.env.PORT || 3000),
  open = true,
  maxPortRetries = 20,
} = {}) {
  const server = createAppServer();

  const listen = (candidatePort) =>
    new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(candidatePort, HOST);
    });

  for (let attempt = 0; attempt <= maxPortRetries; attempt += 1) {
    const candidatePort = port + attempt;

    try {
      await listen(candidatePort);
    } catch (error) {
      if (error?.code === "EADDRINUSE" && attempt < maxPortRetries) {
        continue;
      }
      throw error;
    }

    const appUrl = `http://${HOST}:${server.address().port}`;
    if (attempt > 0) {
      console.log(`Port ${port} was unavailable, using ${candidatePort} instead.`);
    }
    console.log(`Handwriting OCR running at ${appUrl}`);
    if (open) {
      openBrowser(appUrl);
    }
    return { server, port: server.address().port, url: appUrl };
  }

  throw new Error("Could not find an open localhost port.");
}

const isDirectRun =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  startServer({ open: process.env.NO_OPEN !== "1" }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
