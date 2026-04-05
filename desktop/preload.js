import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("desktopApp", {
  getMeta: () => ipcRenderer.invoke("app:get-meta"),
});
