import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/index.js";

let mainWindow = null;
let server = null;
let serverMeta = null;

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const PRELOAD_PATH = fileURLToPath(new URL("./preload.js", import.meta.url));

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 760,
    title: "Handwriting OCR",
    backgroundColor: "#f5efe2",
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(serverMeta.url);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function waitForServer() {
  const maxAttempts = 80;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${serverMeta.url}/api/settings`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server still starting.
    }

    await delay(250);
  }

  throw new Error("Timed out waiting for the local server to start.");
}

function stopServer() {
  if (!serverMeta?.server) {
    return;
  }

  serverMeta.server.close();
  serverMeta = null;
  server = null;
}

ipcMain.handle("app:get-meta", () => ({
  platform: process.platform,
  appVersion: app.getVersion(),
}));

app.whenReady().then(async () => {
  try {
    process.env.APP_DATA_DIR = app.getPath("userData");
    serverMeta = await startServer({ port: PORT, open: false });
    server = serverMeta.server;
    await waitForServer();
    createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "Startup failed",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  stopServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
