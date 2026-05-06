import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("midiStudio", {
  platform: process.platform,
  appVersion: process.versions.electron
});
