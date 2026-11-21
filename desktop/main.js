import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";

import { startServer } from "../server/index.js";
import { setSecretCodec } from "../server/settings-store.js";
import { toMessage } from "../server/util.js";

let mainWindow = null;
let serverMeta = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 760,
    title: "Handwriting OCR",
    backgroundColor: "#eef8f5",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(serverMeta.url);

  // Links leave the app only as ordinary web pages in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(serverMeta.url)) {
      event.preventDefault();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function focusMainWindow() {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
}

// Keeps the API key in the operating system keychain where one is available.
function installSecretCodec() {
  if (!safeStorage.isEncryptionAvailable()) {
    return;
  }

  setSecretCodec({
    encrypt: (text) => safeStorage.encryptString(text).toString("base64"),
    decrypt: (encoded) => safeStorage.decryptString(Buffer.from(encoded, "base64")),
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", focusMainWindow);

  app.whenReady().then(async () => {
    try {
      process.env.APP_DATA_DIR = app.getPath("userData");
      installSecretCodec();
      // Port 0 lets the system pick a free port, so nothing else can clash.
      serverMeta = await startServer({ port: 0, open: false, maxPortRetries: 0 });
      createWindow();
    } catch (error) {
      dialog.showErrorBox("Startup failed", toMessage(error));
      app.quit();
      return;
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("before-quit", () => {
    serverMeta?.server.close();
    serverMeta = null;
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}
