import type {
  MidiPlaybackEngine,
  PlayerLoadInput,
  PlayerSnapshot,
  PlayerStatus
} from "./types";
import type { AlphaSynthApi } from "../../types/alphaSynth";

const SOUNDFONT_URL = new URL(
  "./soundfonts/midiSound-2025-1-14.sf2",
  window.location.href
).toString();
const ALPHASYNTH_SCRIPT_URL = new URL(
  "./vendor/alphasynth/alphaSynth.min.js",
  window.location.href
).toString();

let alphaSynthScriptPromise: Promise<void> | null = null;

export class AlphaSynthPlayer implements MidiPlaybackEngine {
  private synth: AlphaSynthApi | null = null;
  private midiBytes: ArrayBuffer | null = null;
  private soundFontReady = false;
  private soundFontError: Error | null = null;
  private soundFontTimeoutId = 0;
  private midiReady = false;
  private disposed = false;
  private speed = 1;
  private snapshot: PlayerSnapshot = {
    status: "idle",
    positionMs: 0,
    durationMs: 0
  };
  private listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  private pendingLoad:
    | {
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | null = null;

  async load(input: PlayerLoadInput): Promise<void> {
    this.snapshot = {
      status: this.soundFontReady ? "loading-midi" : "loading-soundfont",
      positionMs: 0,
      durationMs: input.durationMs,
      loadingMessage: this.soundFontReady ? "MIDI 加载中" : "音源加载中"
    };
    this.emit();

    await this.createSynth();

    if (!this.synth) {
      return Promise.reject(new Error(this.snapshot.error ?? "alphaSynth 未初始化。"));
    }

    if (this.soundFontError) {
      return Promise.reject(this.soundFontError);
    }

    this.synth.stop();
    this.midiBytes = input.midiBytes.slice(0);
    this.midiReady = false;

    return new Promise((resolve, reject) => {
      this.pendingLoad = { resolve, reject };
      this.loadMidiIfPossible();
    });
  }

  async play(): Promise<void> {
    if (!this.synth || !this.midiReady || this.snapshot.status === "error") {
      return;
    }

    if (this.snapshot.positionMs >= this.snapshot.durationMs) {
      this.seek(0);
    }

    this.synth.play();
  }

  pause(): void {
    this.synth?.pause();
    if (this.snapshot.status === "playing") {
      this.setSnapshot({ status: "paused" });
    }
  }

  stop(): void {
    this.synth?.stop();
    this.setSnapshot({
      status: this.midiReady ? "ready" : "idle",
      positionMs: 0
    });
  }

  seek(positionMs: number): void {
    const nextPosition = Math.max(0, Math.min(positionMs, this.snapshot.durationMs));
    this.synth?.setTimePosition(nextPosition);
    this.setSnapshot({ positionMs: nextPosition });
  }

  setSpeed(percent: number): void {
    this.speed = Math.max(0.1, Math.min(percent / 100, 2));
    this.synth?.setPlaybackSpeed(this.speed);
  }

  dispose(): void {
    this.disposed = true;
    this.clearSoundFontTimeout();
    this.pendingLoad?.reject(new Error("播放器已释放。"));
    this.pendingLoad = null;
    this.listeners.clear();
    try {
      this.synth?.pause();
      this.synth?.destroy();
    } catch {
      // alphaSynth may already be shutting down.
    }
    this.synth = null;
  }

  getSnapshot(): PlayerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private async createSynth(): Promise<void> {
    if (this.synth) {
      return;
    }

    try {
      await loadAlphaSynthScript();
    } catch (error) {
      this.setError(error instanceof Error ? error.message : "alphaSynth 脚本加载失败。");
      return;
    }

    if (!window.alphaSynth) {
      this.setError("alphaSynth 未加载。");
      return;
    }

    const settings = new window.alphaSynth.Settings();
    settings.soundFont = SOUNDFONT_URL;
    settings.bufferTimeInMilliseconds = 1000;
    settings.logLevel = window.alphaSynth.LogLevel.None;
    settings.outputMode = window.alphaSynth.PlayerOutputMode.WebAudioScriptProcessor;

    this.synth = new window.alphaSynth.AlphaSynthApi(settings);
    this.synth.ready.on(() => {
      if (this.disposed || !this.synth) {
        return;
      }
      this.synth.setMasterVolume(1);
      this.startSoundFontTimeout();
    });
    this.synth.soundFontLoaded.on(() => {
      if (this.disposed) {
        return;
      }
      this.clearSoundFontTimeout();
      this.soundFontReady = true;
      this.loadMidiIfPossible();
    });
    this.synth.soundFontLoadFailed.on((event) => {
      if (!this.disposed) {
        this.clearSoundFontTimeout();
        this.soundFontError = toError(event, "SF2 音源加载失败。");
        this.rejectPendingLoad(this.soundFontError);
      }
    });
    this.synth.midiLoaded.on((event) => {
      if (this.disposed) {
        return;
      }
      this.midiReady = true;
      this.setSnapshot({
        status: "ready",
        positionMs: event.currentTime ?? 0,
        durationMs: event.endTime ?? this.snapshot.durationMs,
        loadingMessage: undefined,
        error: undefined
      });
      this.pendingLoad?.resolve();
      this.pendingLoad = null;
    });
    this.synth.midiLoadFailed.on((event) => {
      if (!this.disposed) {
        this.rejectPendingLoad(toError(event, "MIDI 加载到 alphaSynth 失败。"));
      }
    });
    this.synth.positionChanged.on((event) => {
      if (this.disposed) {
        return;
      }
      this.setSnapshot({
        positionMs: event.currentTime ?? this.snapshot.positionMs,
        durationMs: event.endTime ?? this.snapshot.durationMs
      });
    });
    this.synth.stateChanged.on((event) => {
      if (this.disposed || !this.midiReady) {
        return;
      }

      this.setSnapshot({
        status: event.state === 1 ? "playing" : event.stopped ? "ready" : "paused"
      });
    });
    this.synth.finished.on(() => {
      if (this.disposed) {
        return;
      }
      this.setSnapshot({
        status: "ended",
        positionMs: this.snapshot.durationMs
      });
    });
  }

  private loadMidiIfPossible(): void {
    if (!this.synth || !this.soundFontReady || !this.midiBytes) {
      return;
    }

    this.setSnapshot({
      status: "loading-midi",
      loadingMessage: "MIDI 加载中"
    });
    this.synth.setPlaybackSpeed(this.speed);
    this.synth.loadMidiFile(this.midiBytes);
  }

  private startSoundFontTimeout(): void {
    this.clearSoundFontTimeout();
    this.soundFontTimeoutId = window.setTimeout(() => {
      if (this.soundFontReady || this.soundFontError || this.disposed) {
        return;
      }

      this.soundFontError = new Error(
        `SF2 音源加载超时，请检查资源路径：${SOUNDFONT_URL}`
      );
      this.rejectPendingLoad(this.soundFontError);
    }, 15000);
  }

  private clearSoundFontTimeout(): void {
    if (this.soundFontTimeoutId) {
      window.clearTimeout(this.soundFontTimeoutId);
      this.soundFontTimeoutId = 0;
    }
  }

  private rejectPendingLoad(error: Error): void {
    this.setError(error.message);
    this.pendingLoad?.reject(error);
    this.pendingLoad = null;
  }

  private setError(message: string): void {
    this.snapshot = {
      ...this.snapshot,
      status: "error",
      loadingMessage: undefined,
      error: message
    };
    this.emit();
  }

  private setSnapshot(patch: Partial<PlayerSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.snapshot);
    }
  }
}

function loadAlphaSynthScript(): Promise<void> {
  if (window.alphaSynth) {
    return Promise.resolve();
  }

  if (alphaSynthScriptPromise) {
    return alphaSynthScriptPromise;
  }

  alphaSynthScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[data-midi-studio-alphasynth="true"]`
    );

    if (existingScript) {
      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error("alphaSynth 脚本加载失败。")),
        { once: true }
      );
      return;
    }

    const script = document.createElement("script");
    script.src = ALPHASYNTH_SCRIPT_URL;
    script.async = true;
    script.dataset.midiStudioAlphasynth = "true";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error(`alphaSynth 脚本加载失败：${ALPHASYNTH_SCRIPT_URL}`)),
      { once: true }
    );
    document.head.appendChild(script);
  });

  return alphaSynthScriptPromise;
}

function toError(event: unknown, fallbackMessage: string): Error {
  if (event instanceof Error) {
    return event;
  }

  if (typeof event === "string") {
    return new Error(event);
  }

  if (
    event &&
    typeof event === "object" &&
    "message" in event &&
    typeof event.message === "string"
  ) {
    return new Error(event.message);
  }

  return new Error(fallbackMessage);
}
