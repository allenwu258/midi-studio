/// <reference types="vite/client" />

import type { SettingsStorageInfo, UserSettings } from "./shared/settings";

interface Window {
  midiStudio: {
    platform: string;
    appVersion: string;
    settings: {
      get(): Promise<UserSettings>;
      update(patch: Partial<UserSettings>): Promise<UserSettings>;
      getStorageInfo(): Promise<SettingsStorageInfo>;
    };
  };
}
