import { contextBridge, ipcRenderer } from "electron";
import type { SettingsStorageInfo, UserSettings } from "../shared/settings";

contextBridge.exposeInMainWorld("midiStudio", {
  platform: process.platform,
  appVersion: process.versions.electron,
  settings: {
    get: (): Promise<UserSettings> => ipcRenderer.invoke("settings:get"),
    update: (patch: Partial<UserSettings>): Promise<UserSettings> =>
      ipcRenderer.invoke("settings:update", patch),
    getStorageInfo: (): Promise<SettingsStorageInfo> =>
      ipcRenderer.invoke("settings:storage-info")
  }
});
