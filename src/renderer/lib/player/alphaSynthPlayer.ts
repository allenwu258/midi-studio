import type {
  MidiPlaybackEngine,
  PlayerLoadInput,
  PlayerSnapshot,
  PlayerStatus
} from "./types";
import type { AlphaSynthApi } from "../../types/alphaSynth";

const RESOURCE_BASE_URL = "midi-studio-resource://assets";
const SOUNDFONT_URL = `${RESOURCE_BASE_URL}/soundfonts/midiSound-2025-1-14.sf2`;
const ALPHASYNTH_SCRIPT_URL = `${RESOURCE_BASE_URL}/vendor/alphasynth/alphaSynth.min.js`;
const ALPHASYNTH_SCRIPT_SELECTOR = `script[data-midi-studio-alphasynth="true"]`;

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
  private masterVolume = 1;
  private loadId = 0;
  private snapshot: PlayerSnapshot = {
    status: "idle",
    positionMs: 0,
    durationMs: 0
  };
  private listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  private pendingLoad:
    | {
        loadId: number;
        midiStarted: boolean;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | null = null;

  async load(input: PlayerLoadInput): Promise<void> {
    const loadId = this.startLoad();

    this.snapshot = {
      status: this.soundFontReady ? "loading-midi" : "loading-soundfont",
      positionMs: 0,
      durationMs: input.durationMs,
      loadingMessage: this.soundFontReady ? "MIDI 加载中" : "音源加载中"
    };
    this.emit();

    await this.createSynth();

    if (!this.isCurrentLoad(loadId)) {
      return Promise.reject(new Error("MIDI 加载已被新的请求替代。"));
    }

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
      this.pendingLoad = { loadId, midiStarted: false, resolve, reject };
      this.loadMidiIfPossible(loadId);
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

  setMasterVolume(percent: number): void {
    this.masterVolume = clampVolume(percent);
    this.synth?.setMasterVolume(this.masterVolume);
  }

  dispose(): void {
    this.disposed = true;
    this.loadId += 1;
    this.destroySynth();
    this.pendingLoad?.reject(new Error("播放器已释放。"));
    this.pendingLoad = null;
    this.listeners.clear();
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

    const synth = new window.alphaSynth.AlphaSynthApi(settings);
    this.synth = synth;
    synth.ready.on(() => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      synth.setMasterVolume(this.masterVolume);
      this.startSoundFontTimeout();
    });
    synth.soundFontLoaded.on(() => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      this.clearSoundFontTimeout();
      this.soundFontReady = true;
      this.loadMidiIfPossible();
    });
    synth.soundFontLoadFailed.on((event) => {
      if (!this.disposed && this.synth === synth) {
        this.failSoundFontLoad(toError(event, "SF2 音源加载失败。"));
      }
    });
    synth.midiLoaded.on((event) => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      const pendingLoad = this.pendingLoad;
      if (!pendingLoad || !this.isCurrentLoad(pendingLoad.loadId)) {
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
      pendingLoad.resolve();
      this.pendingLoad = null;
    });
    synth.midiLoadFailed.on((event) => {
      if (!this.disposed && this.synth === synth) {
        this.rejectPendingLoad(toError(event, "MIDI 加载到 alphaSynth 失败。"));
      }
    });
    synth.positionChanged.on((event) => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      this.setSnapshot({
        positionMs: event.currentTime ?? this.snapshot.positionMs,
        durationMs: event.endTime ?? this.snapshot.durationMs
      });
    });
    synth.stateChanged.on((event) => {
      if (this.disposed || this.synth !== synth || !this.midiReady) {
        return;
      }

      this.setSnapshot({
        status: event.state === 1 ? "playing" : event.stopped ? "ready" : "paused"
      });
    });
    synth.finished.on(() => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      this.setSnapshot({
        status: "ended",
        positionMs: this.snapshot.durationMs
      });
    });
  }

  private loadMidiIfPossible(loadId = this.pendingLoad?.loadId): void {
    const pendingLoad = this.pendingLoad;
    if (
      !this.synth ||
      !this.soundFontReady ||
      !this.midiBytes ||
      !pendingLoad ||
      loadId !== pendingLoad.loadId ||
      !this.isCurrentLoad(loadId)
    ) {
      return;
    }

    this.setSnapshot({
      status: "loading-midi",
      loadingMessage: "MIDI 加载中"
    });
    this.synth.setPlaybackSpeed(this.speed);
    pendingLoad.midiStarted = true;
    this.synth.loadMidiFile(this.midiBytes);
  }

  private startSoundFontTimeout(): void {
    this.clearSoundFontTimeout();
    this.soundFontTimeoutId = window.setTimeout(() => {
      if (this.soundFontReady || this.soundFontError || this.disposed) {
        return;
      }

      this.failSoundFontLoad(
        new Error(`SF2 音源加载超时，请检查资源路径：${SOUNDFONT_URL}`)
      );
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

  private failSoundFontLoad(error: Error): void {
    this.clearSoundFontTimeout();
    this.soundFontError = error;
    this.soundFontReady = false;
    this.midiReady = false;
    this.rejectPendingLoad(error);
    this.destroySynth();
  }

  private startLoad(): number {
    if (this.pendingLoad) {
      if (this.pendingLoad.midiStarted) {
        this.destroySynth();
        this.soundFontReady = false;
        this.soundFontError = null;
        this.midiReady = false;
      }
      this.pendingLoad.reject(new Error("MIDI 加载已被新的请求替代。"));
      this.pendingLoad = null;
    }

    if (this.soundFontError) {
      this.destroySynth();
      this.soundFontReady = false;
      this.soundFontError = null;
      this.midiReady = false;
    }

    this.loadId += 1;
    return this.loadId;
  }

  private isCurrentLoad(loadId: number | undefined): loadId is number {
    return !this.disposed && loadId === this.loadId;
  }

  private destroySynth(): void {
    this.clearSoundFontTimeout();
    try {
      this.synth?.pause();
      this.synth?.destroy();
    } catch {
      // alphaSynth may already be shutting down.
    }
    this.synth = null;
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

  const scriptPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      ALPHASYNTH_SCRIPT_SELECTOR
    );

    if (existingScript) {
      if (existingScript.dataset.midiStudioAlphasynthStatus === "loaded") {
        if (window.alphaSynth) {
          resolve();
          return;
        }

        resetAlphaSynthScript(existingScript);
      }

      if (existingScript.dataset.midiStudioAlphasynthStatus === "failed") {
        existingScript.remove();
      } else {
        existingScript.addEventListener("load", () => resolve(), { once: true });
        existingScript.addEventListener(
          "error",
          () => {
            resetAlphaSynthScript(existingScript);
            reject(new Error("alphaSynth 脚本加载失败。"));
          },
          { once: true }
        );
        return;
      }
    }

    const script = document.createElement("script");
    script.src = ALPHASYNTH_SCRIPT_URL;
    script.async = true;
    script.dataset.midiStudioAlphasynth = "true";
    script.dataset.midiStudioAlphasynthStatus = "loading";
    script.addEventListener(
      "load",
      () => {
        script.dataset.midiStudioAlphasynthStatus = "loaded";
        resolve();
      },
      { once: true }
    );
    script.addEventListener(
      "error",
      () => {
        resetAlphaSynthScript(script);
        reject(new Error(`alphaSynth 脚本加载失败：${ALPHASYNTH_SCRIPT_URL}`));
      },
      { once: true }
    );
    document.head.appendChild(script);
  }).catch((error) => {
    alphaSynthScriptPromise = null;
    throw error;
  });

  alphaSynthScriptPromise = scriptPromise;
  return scriptPromise;
}

function resetAlphaSynthScript(script: HTMLScriptElement): void {
  alphaSynthScriptPromise = null;
  script.dataset.midiStudioAlphasynthStatus = "failed";
  script.remove();
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

function clampVolume(percent: number): number {
  return Math.max(0, Math.min(percent / 100, 1));
}
