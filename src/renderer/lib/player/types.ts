import type { PlaybackEngineMode } from "../../../shared/settings";
import type { MidiNote } from "../midi";

export type PlayerStatus =
  | "idle"
  | "loading-soundfont"
  | "loading-midi"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export type PlayerSnapshot = {
  status: PlayerStatus;
  positionMs: number;
  durationMs: number;
  loadingMessage?: string;
  error?: string;
};

export type PlayerLoadInput = {
  midiBytes: ArrayBuffer;
  notes: MidiNote[];
  durationMs: number;
};

export interface MidiPlaybackEngine {
  load(input: PlayerLoadInput): Promise<void> | void;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(positionMs: number): void;
  setSpeed(percent: number): void;
  dispose(): void;
  getSnapshot(): PlayerSnapshot;
  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void;
}

export type PlayerFactoryOptions = {
  mode: PlaybackEngineMode;
};
