import type { SettingsStorageInfo, UserSettings } from "../../shared/settings";

declare global {
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
}

export {};
