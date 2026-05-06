import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import {
  registerResourceProtocol,
  registerResourceProtocolScheme
} from "./resources/resourceProtocol";
import { registerSettingsHandlers } from "./settings/settingsService";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

registerResourceProtocolScheme();

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    title: "midi-studio",
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerResourceProtocol();
  registerSettingsHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
