import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { listModels, mergeSettings } from "./models-service.js";
import { loadSettings, saveSettings } from "./settings-store.js";
import { transcribeDocument } from "./transcription-service.js";

const HOST = "127.0.0.1";
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
  });
  response.end(body);
}

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(requestPath).replace(/^[/\\]+/, "").replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    sendText(response, 404, "Not found");
    return;
  }

  const fileStats = await stat(filePath);
  if (fileStats.isDirectory()) {
    sendText(response, 404, "Not found");
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const body = await readFile(filePath);
  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
  });
  response.end(body);
}

async function handleApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    sendText(response, 204, "");
    return true;
  }

  if (url.pathname === "/api/settings" && request.method === "GET") {
    sendJson(response, 200, loadSettings());
    return true;
  }

  if (url.pathname === "/api/settings" && request.method === "PUT") {
    try {
      const payload = await readRequestBody(request);
      const settings = saveSettings(payload);
      sendJson(response, 200, settings);
    } catch (error) {
      sendJson(response, 400, {
        error: "Could not save settings.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === "/api/models" && (request.method === "GET" || request.method === "POST")) {
    try {
      const payload = request.method === "POST" ? await readRequestBody(request) : {};
      const providerName =
        payload?.provider ||
        url.searchParams.get("provider") ||
        "openrouter";
      const settings = mergeSettings(loadSettings(), payload?.settings || {});
      const result = await listModels({ providerName }, settings);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {
        error: "Could not load models.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === "/api/transcribe" && request.method === "POST") {
    try {
      const payload = await readRequestBody(request);
      const result = await transcribeDocument(payload, loadSettings());
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 400, {
        error: "Transcription failed.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}

function openBrowser(url) {
  if (process.env.NO_OPEN === "1") {
    return;
  }

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
      if (!request.url) {
        sendText(response, 400, "Missing URL");
        return;
      }

      const handled = await handleApi(request, response);
      if (handled) {
        return;
      }

      await serveStatic(request, response);
    } catch (error) {
      sendJson(response, 500, {
        error: "Unexpected server error.",
        details: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

export function startServer({
  port = Number(process.env.PORT || 3000),
  open = true,
  maxPortRetries = 20,
} = {}) {
  const basePort = port;
  let currentPort = basePort;
  const server = createAppServer();
  const listen = () =>
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
      server.listen(currentPort, HOST);
    });

  return (async () => {
    for (let attempt = 0; attempt <= maxPortRetries; attempt += 1) {
      try {
        await listen();
        const appUrl = `http://${HOST}:${currentPort}`;
        if (currentPort !== basePort) {
          console.log(
            `Port ${basePort} was unavailable, using ${currentPort} instead.`
          );
        }
        console.log(`Handwriting OCR running at ${appUrl}`);
        if (open) {
          openBrowser(appUrl);
        }
        return { server, port: currentPort, url: appUrl };
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          error.code === "EADDRINUSE" &&
          attempt < maxPortRetries
        ) {
          currentPort += 1;
          continue;
        }

        throw error;
      }
    }

    throw new Error("Could not find an open localhost port.");
  })();
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  startServer({
    port: Number(process.env.PORT || 3000),
    open: process.env.NO_OPEN !== "1",
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
