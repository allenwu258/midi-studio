import { ipcMain } from "electron";

import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type SettingsStorageInfo,
  type UserSettings
} from "../../shared/settings";
import { getSettingsStorageInfo, readSettingValue, writeSettingValue } from "./settingsDb";

const SETTINGS_KEY = "user_settings";

export function registerSettingsHandlers(): void {
  ipcMain.handle("settings:get", () => getUserSettings());
  ipcMain.handle("settings:update", (_event, patch: Partial<UserSettings>) =>
    updateUserSettings(patch)
  );
  ipcMain.handle("settings:storage-info", () => getStorageInfo());
}

export async function getUserSettings(): Promise<UserSettings> {
  const rawValue = await readSettingValue(SETTINGS_KEY);
  if (!rawValue) {
    return DEFAULT_SETTINGS;
  }

  try {
    return normalizeSettings(JSON.parse(rawValue) as Partial<UserSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function updateUserSettings(patch: Partial<UserSettings>): Promise<UserSettings> {
  const current = await getUserSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await writeSettingValue(SETTINGS_KEY, JSON.stringify(next));

  return next;
}

export function getStorageInfo(): SettingsStorageInfo {
  return getSettingsStorageInfo();
}
