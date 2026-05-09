export type PlaybackEngineMode = "basic-midi" | "sf2-synth";
export type NotationRendererMode = "classic" | "engraved";

export type UserSettings = {
  playbackEngineMode: PlaybackEngineMode;
  notationRendererMode: NotationRendererMode;
  defaultSpeedPercent: number;
  masterVolumePercent: number;
  followPlayback: boolean;
};

export type SettingsStorageInfo = {
  dataDir: string;
  dbPath: string;
};

export const DEFAULT_SETTINGS: UserSettings = {
  playbackEngineMode: "sf2-synth",
  notationRendererMode: "engraved",
  defaultSpeedPercent: 100,
  masterVolumePercent: 100,
  followPlayback: true
};

export function normalizeSettings(input: Partial<UserSettings> | null | undefined): UserSettings {
  const settings = { ...DEFAULT_SETTINGS, ...(input ?? {}) };

  return {
    playbackEngineMode:
      settings.playbackEngineMode === "basic-midi" ? "basic-midi" : "sf2-synth",
    notationRendererMode:
      settings.notationRendererMode === "classic" ? "classic" : "engraved",
    defaultSpeedPercent: clampPercent(settings.defaultSpeedPercent, 50, 150, 100),
    masterVolumePercent: clampPercent(settings.masterVolumePercent, 0, 100, 100),
    followPlayback: Boolean(settings.followPlayback)
  };
}

function clampPercent(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.round(Math.max(min, Math.min(max, value)));
}
