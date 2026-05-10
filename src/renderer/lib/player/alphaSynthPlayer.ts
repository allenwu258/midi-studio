import type {
  MidiPlaybackEngine,
  PlayerDiagnostics,
  PlayerLoadInput,
  PlayerSeekOptions,
  PlayerSnapshot,
  PlayerStatus
} from "./types";
import type { AlphaSynthApi } from "../../types/alphaSynth";

const RESOURCE_BASE_URL = "midi-studio-resource://assets";
const SOUNDFONT_URL = `${RESOURCE_BASE_URL}/soundfonts/midiSound-2025-1-14.sf2`;
const ALPHASYNTH_SCRIPT_URL = `${RESOURCE_BASE_URL}/vendor/alphasynth/alphaSynth.min.js`;
const ALPHASYNTH_SCRIPT_SELECTOR = `script[data-midi-studio-alphasynth="true"]`;
const ALPHASYNTH_WORKLET_READY_TIMEOUT_MS = 5000;
const SEEK_FADE_OUT_MS = 80;
const SEEK_FADE_IN_MS = 100;
const SEEK_SETTLE_MS = 60;
const SEEK_MUTED_VOLUME = 0.0001;
const TRANSPORT_FADE_IN_MS = 50;
const TRANSPORT_FADE_OUT_MS = 70;

let alphaSynthScriptPromise: Promise<void> | null = null;

type AlphaSynthOutputMode = "audio-worklet" | "script-processor";
type TransportAction = "play" | "pause" | "stop";

export class AlphaSynthPlayer implements MidiPlaybackEngine {
  private synth: AlphaSynthApi | null = null;
  private midiBytes: ArrayBuffer | null = null;
  private soundFontReady = false;
  private soundFontError: Error | null = null;
  private soundFontTimeoutId = 0;
  private synthReadyTimeoutId = 0;
  private scriptLoadStartedAt: number | null = null;
  private synthReadyStartedAt: number | null = null;
  private soundFontLoadStartedAt: number | null = null;
  private midiLoadStartedAt: number | null = null;
  private midiReady = false;
  private disposed = false;
  private speed = 1;
  private masterVolume = 1;
  private appliedMasterVolume = 1;
  private loadId = 0;
  private seekTimerId = 0;
  private seekTransitionId = 0;
  private transportTransitionId = 0;
  private pendingSeekPositionMs: number | null = null;
  private activeSeekTransitionId: number | null = null;
  private activeTransportTransitionId: number | null = null;
  private pendingTransportAction: TransportAction | null = null;
  private lastSeekRequestedAt: number | null = null;
  private seekRequestCount = 0;
  private seekCommitCount = 0;
  private seekDroppedCount = 0;
  private snapshot: PlayerSnapshot = {
    status: "idle",
    positionMs: 0,
    durationMs: 0
  };
  private listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  private diagnosticsListeners = new Set<(diagnostics: PlayerDiagnostics) => void>();
  private diagnostics: PlayerDiagnostics = {
    engine: "sf2-synth",
    outputMode: "unknown"
  };
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

    this.cancelSeekTransition({ restoreVolume: true, countDropped: false });
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
      this.seek(0, { smooth: false, diagnostic: false });
    }

    const previousTransportAction = this.pendingTransportAction;
    const transitionId = this.beginTransportTransition("play");
    this.applySynthVolume(SEEK_MUTED_VOLUME);
    if (previousTransportAction === "stop") {
      this.synth.setTimePosition(this.snapshot.positionMs);
    }
    this.synth.play();
    this.setSnapshot({ status: "playing" });
    this.fadeTransportVolume(transitionId, this.masterVolume, TRANSPORT_FADE_IN_MS);
    window.setTimeout(() => {
      this.finishTransportTransition(transitionId, "play", true);
    }, TRANSPORT_FADE_IN_MS);
  }

  pause(): void {
    this.cancelSeekTransition({ restoreVolume: true, countDropped: true });
    const synth = this.synth;
    const transitionId = this.beginTransportTransition("pause");
    this.fadeTransportVolume(transitionId, SEEK_MUTED_VOLUME, TRANSPORT_FADE_OUT_MS);
    window.setTimeout(() => {
      if (!this.isCurrentTransportAction(transitionId, "pause", synth)) {
        return;
      }

      synth?.pause();
      this.finishTransportTransition(transitionId, "pause", false);
    }, TRANSPORT_FADE_OUT_MS);
    if (this.snapshot.status === "playing") {
      this.setSnapshot({ status: "paused" });
    }
  }

  stop(): void {
    this.cancelSeekTransition({ restoreVolume: true, countDropped: true });
    const synth = this.synth;
    const transitionId = this.beginTransportTransition("stop");
    this.fadeTransportVolume(transitionId, SEEK_MUTED_VOLUME, TRANSPORT_FADE_OUT_MS);
    window.setTimeout(() => {
      if (!this.isCurrentTransportAction(transitionId, "stop", synth)) {
        return;
      }

      synth?.stop();
      this.finishTransportTransition(transitionId, "stop", false);
    }, TRANSPORT_FADE_OUT_MS);
    this.setSnapshot({
      status: this.midiReady ? "ready" : "idle",
      positionMs: 0
    });
  }

  seek(positionMs: number, options: PlayerSeekOptions = {}): void {
    const nextPosition = Math.max(0, Math.min(positionMs, this.snapshot.durationMs));
    const shouldRecordDiagnostics = options.diagnostic !== false;
    if (shouldRecordDiagnostics) {
      this.recordSeekRequest();
    }

    if (options.smooth === false) {
      this.cancelSeekTransition({ restoreVolume: false, countDropped: shouldRecordDiagnostics });
      this.commitSeek(nextPosition, false, shouldRecordDiagnostics);
      return;
    }

    if (this.activeSeekTransitionId !== null) {
      this.cancelSeekTransition({ restoreVolume: false, countDropped: shouldRecordDiagnostics });
    }

    this.pendingSeekPositionMs = nextPosition;
    if (this.seekTimerId) {
      if (shouldRecordDiagnostics) {
        this.recordSeekDropped();
      }
      return;
    }

    this.seekTimerId = window.setTimeout(() => {
      this.seekTimerId = 0;
      const pendingPosition = this.pendingSeekPositionMs;
      this.pendingSeekPositionMs = null;
      if (pendingPosition !== null) {
        this.commitSeek(pendingPosition, true, shouldRecordDiagnostics);
      }
    }, 0);
  }

  setSpeed(percent: number): void {
    this.speed = Math.max(0.1, Math.min(percent / 100, 2));
    this.synth?.setPlaybackSpeed(this.speed);
  }

  setMasterVolume(percent: number): void {
    this.masterVolume = clampVolume(percent);
    if (
      !this.pendingSeekPositionMs &&
      !this.seekTimerId &&
      this.activeSeekTransitionId === null &&
      this.activeTransportTransitionId === null
    ) {
      this.applySynthVolume(this.masterVolume);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.loadId += 1;
    this.cancelSeekTransition({ restoreVolume: false, countDropped: false });
    this.destroySynth();
    this.pendingLoad?.reject(new Error("播放器已释放。"));
    this.pendingLoad = null;
    this.listeners.clear();
    this.diagnosticsListeners.clear();
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

  getDiagnostics(): PlayerDiagnostics {
    return this.diagnostics;
  }

  subscribeDiagnostics(listener: (diagnostics: PlayerDiagnostics) => void): () => void {
    this.diagnosticsListeners.add(listener);
    listener(this.getDiagnostics());
    return () => {
      this.diagnosticsListeners.delete(listener);
    };
  }

  private async createSynth(): Promise<void> {
    if (this.synth) {
      return;
    }

    this.scriptLoadStartedAt = performance.now();
    try {
      await loadAlphaSynthScript();
      this.patchDiagnostics({
        alphaSynthScriptLoadMs: elapsedSince(this.scriptLoadStartedAt)
      });
    } catch (error) {
      this.patchDiagnostics({ lastErrorType: "script-load" });
      this.setError(error instanceof Error ? error.message : "alphaSynth 脚本加载失败。");
      return;
    }

    if (!window.alphaSynth) {
      this.patchDiagnostics({ lastErrorType: "script-load" });
      this.setError("alphaSynth 未加载。");
      return;
    }

    let lastError: unknown = null;

    for (const outputMode of getAlphaSynthOutputModeAttempts()) {
      try {
        this.createAlphaSynthApi(outputMode);
        return;
      } catch (error) {
        lastError = error;
        this.patchDiagnostics({
          fallbackReason:
            outputMode === "audio-worklet"
              ? toError(error, "AudioWorklet 初始化失败。").message
              : this.diagnostics.fallbackReason,
          lastErrorType: outputMode === "audio-worklet" ? "worklet-init" : "synth-init"
        });
        this.destroySynth();
      }
    }

    this.setError(
      lastError instanceof Error
        ? `alphaSynth 初始化失败：${lastError.message}`
        : "alphaSynth 初始化失败。"
    );
  }

  private createAlphaSynthApi(outputMode: AlphaSynthOutputMode): AlphaSynthApi {
    if (!window.alphaSynth) {
      throw new Error("alphaSynth 未加载。");
    }

    const settings = new window.alphaSynth.Settings();
    settings.soundFont = SOUNDFONT_URL;
    settings.bufferTimeInMilliseconds = 1000;
    settings.logLevel = window.alphaSynth.LogLevel.None;
    settings.outputMode = getAlphaSynthOutputModeValue(outputMode);

    this.synthReadyStartedAt = performance.now();
    this.patchDiagnostics({
      outputMode: outputMode === "audio-worklet" ? "audio-worklet" : "script-processor"
    });
    const synth = new window.alphaSynth.AlphaSynthApi(settings);
    this.synth = synth;
    this.startSynthReadyFallbackTimeout(synth, outputMode);
    synth.ready.on(() => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      this.clearSynthReadyTimeout();
      this.soundFontLoadStartedAt = performance.now();
      this.patchDiagnostics({
        synthReadyMs: elapsedSince(this.synthReadyStartedAt),
        outputMode: outputMode === "audio-worklet" ? "audio-worklet" : "script-processor"
      });
      this.applySynthVolume(this.masterVolume);
      this.startSoundFontTimeout();
    });
    synth.soundFontLoaded.on(() => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      this.clearSoundFontTimeout();
      this.soundFontReady = true;
      this.patchDiagnostics({
        soundFontLoadMs: elapsedSince(this.soundFontLoadStartedAt)
      });
      this.loadMidiIfPossible();
    });
    synth.soundFontLoadFailed.on((event) => {
      if (!this.disposed && this.synth === synth) {
        this.patchDiagnostics({ lastErrorType: "soundfont-load" });
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
      this.patchDiagnostics({
        midiLoadMs: elapsedSince(this.midiLoadStartedAt)
      });
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
        this.patchDiagnostics({ lastErrorType: "midi-load" });
        this.rejectPendingLoad(toError(event, "MIDI 加载到 alphaSynth 失败。"));
      }
    });
    synth.positionChanged.on((event) => {
      if (this.disposed || this.synth !== synth) {
        return;
      }
      if (this.pendingTransportAction === "stop") {
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
      if (
        this.pendingTransportAction === "pause" ||
        this.pendingTransportAction === "stop"
      ) {
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

    return synth;
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
    this.midiLoadStartedAt = performance.now();
    pendingLoad.midiStarted = true;
    this.synth.loadMidiFile(this.midiBytes);
  }

  private commitSeek(positionMs: number, smooth: boolean, diagnostic: boolean): void {
    const synth = this.synth;
    const wasPlaying = this.snapshot.status === "playing";
    const transitionId = ++this.seekTransitionId;
    const startedAt = performance.now();

    if (!synth) {
      this.setSnapshot({ positionMs });
      if (diagnostic) {
        this.recordSeekCommit(performance.now() - startedAt);
      }
      return;
    }

    if (!smooth || !wasPlaying) {
      synth.setTimePosition(positionMs);
      this.setSnapshot({ positionMs });
      if (diagnostic) {
        this.recordSeekCommit(performance.now() - startedAt);
      }
      return;
    }

    this.activeSeekTransitionId = transitionId;
    this.fadeMasterVolume(SEEK_MUTED_VOLUME, SEEK_FADE_OUT_MS);
    window.setTimeout(() => {
      if (this.disposed || this.synth !== synth || transitionId !== this.seekTransitionId) {
        return;
      }

      if (this.snapshot.status !== "playing") {
        this.abortActiveSeekTransition(transitionId, {
          restoreVolume: true,
          countDropped: diagnostic
        });
        return;
      }

      synth.setTimePosition(positionMs);
      this.setSnapshot({ positionMs });

      window.setTimeout(() => {
        if (this.disposed || this.synth !== synth || transitionId !== this.seekTransitionId) {
          return;
        }

        if (this.snapshot.status !== "playing") {
          this.abortActiveSeekTransition(transitionId, {
            restoreVolume: true,
            countDropped: diagnostic
          });
          return;
        }

        this.fadeMasterVolume(this.masterVolume, SEEK_FADE_IN_MS);
        window.setTimeout(() => {
          if (this.activeSeekTransitionId === transitionId) {
            this.activeSeekTransitionId = null;
            this.applySynthVolume(this.masterVolume);
            if (diagnostic) {
              this.recordSeekCommit(performance.now() - startedAt);
            }
          }
        }, SEEK_FADE_IN_MS);
      }, SEEK_SETTLE_MS);
    }, SEEK_FADE_OUT_MS);
  }

  private abortActiveSeekTransition(
    transitionId: number,
    {
      restoreVolume,
      countDropped
    }: {
      restoreVolume: boolean;
      countDropped: boolean;
    }
  ): void {
    if (this.activeSeekTransitionId !== transitionId) {
      return;
    }

    this.activeSeekTransitionId = null;
    this.seekTransitionId += 1;
    if (countDropped) {
      this.recordSeekDropped();
    }
    if (restoreVolume) {
      this.applySynthVolume(this.masterVolume);
    }
  }

  private beginTransportTransition(action: TransportAction): number {
    const transitionId = ++this.transportTransitionId;
    this.activeTransportTransitionId = transitionId;
    this.pendingTransportAction = action;
    return transitionId;
  }

  private finishTransportTransition(
    transitionId: number,
    action: TransportAction,
    applyLatestVolume: boolean
  ): void {
    if (
      this.activeTransportTransitionId !== transitionId ||
      this.pendingTransportAction !== action
    ) {
      return;
    }

    this.activeTransportTransitionId = null;
    this.pendingTransportAction = null;
    if (applyLatestVolume) {
      this.applySynthVolume(this.masterVolume);
    }
  }

  private cancelTransportTransition(): void {
    this.activeTransportTransitionId = null;
    this.pendingTransportAction = null;
    this.transportTransitionId += 1;
  }

  private isCurrentTransportAction(
    transitionId: number,
    action: TransportAction,
    synth: AlphaSynthApi | null
  ): boolean {
    return (
      !this.disposed &&
      this.synth === synth &&
      this.activeTransportTransitionId === transitionId &&
      this.pendingTransportAction === action
    );
  }

  private fadeTransportVolume(transitionId: number, targetVolume: number, durationMs: number): void {
    const synth = this.synth;
    const steps = Math.max(2, Math.ceil(durationMs / 8));
    const startVolume = this.appliedMasterVolume;

    for (let step = 1; step <= steps; step += 1) {
      window.setTimeout(() => {
        if (
          this.disposed ||
          this.synth !== synth ||
          this.activeTransportTransitionId !== transitionId
        ) {
          return;
        }

        const ratio = step / steps;
        const volume = startVolume + (targetVolume - startVolume) * ratio;
        this.applySynthVolume(volume);
      }, (durationMs * step) / steps);
    }
  }

  private fadeMasterVolume(targetVolume: number, durationMs: number): void {
    const transitionId = this.seekTransitionId;
    const synth = this.synth;
    const steps = Math.max(2, Math.ceil(durationMs / 8));
    const startVolume = this.appliedMasterVolume;

    for (let step = 1; step <= steps; step += 1) {
      window.setTimeout(() => {
        if (this.disposed || this.synth !== synth || transitionId !== this.seekTransitionId) {
          return;
        }

        const ratio = step / steps;
        const volume = startVolume + (targetVolume - startVolume) * ratio;
        this.applySynthVolume(volume);
      }, (durationMs * step) / steps);
    }
  }

  private applySynthVolume(volume: number): void {
    const nextVolume = Math.max(0, Math.min(volume, 1));
    this.appliedMasterVolume = nextVolume;
    this.synth?.setMasterVolume(nextVolume);
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

  private startSynthReadyFallbackTimeout(
    synth: AlphaSynthApi,
    outputMode: AlphaSynthOutputMode
  ): void {
    this.clearSynthReadyTimeout();

    if (outputMode !== "audio-worklet") {
      return;
    }

    this.synthReadyTimeoutId = window.setTimeout(() => {
      if (this.disposed || this.synth !== synth || this.soundFontReady) {
        return;
      }

      this.destroySynth();
      this.patchDiagnostics({
        fallbackReason: "AudioWorklet ready 超时，已回退到 ScriptProcessor。",
        lastErrorType: "worklet-ready-timeout"
      });

      try {
        this.createAlphaSynthApi("script-processor");
      } catch (error) {
        this.patchDiagnostics({ lastErrorType: "script-processor-fallback" });
        this.setError(
          error instanceof Error
            ? `alphaSynth 回退到 ScriptProcessor 失败：${error.message}`
            : "alphaSynth 回退到 ScriptProcessor 失败。"
        );
      }
    }, ALPHASYNTH_WORKLET_READY_TIMEOUT_MS);
  }

  private clearSynthReadyTimeout(): void {
    if (this.synthReadyTimeoutId) {
      window.clearTimeout(this.synthReadyTimeoutId);
      this.synthReadyTimeoutId = 0;
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
    this.cancelSeekTransition({ restoreVolume: false, countDropped: false });
    this.cancelTransportTransition();
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
    this.cancelSeekTransition({ restoreVolume: false, countDropped: false });
    this.cancelTransportTransition();
    this.clearSynthReadyTimeout();
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

  private patchDiagnostics(patch: Partial<PlayerDiagnostics>): void {
    this.diagnostics = {
      ...this.diagnostics,
      ...patch
    };
    this.emitDiagnostics();
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

  private emitDiagnostics(): void {
    for (const listener of this.diagnosticsListeners) {
      listener(this.diagnostics);
    }
  }

  private cancelSeekTransition({
    restoreVolume,
    countDropped
  }: {
    restoreVolume: boolean;
    countDropped: boolean;
  }): void {
    const hadPendingOrActive = this.seekTimerId !== 0 || this.activeSeekTransitionId !== null;
    if (this.seekTimerId) {
      window.clearTimeout(this.seekTimerId);
      this.seekTimerId = 0;
    }
    this.pendingSeekPositionMs = null;
    this.activeSeekTransitionId = null;
    this.seekTransitionId += 1;
    if (countDropped && hadPendingOrActive) {
      this.recordSeekDropped();
    }
    if (restoreVolume) {
      this.applySynthVolume(this.masterVolume);
    }
  }

  private recordSeekRequest(): void {
    const now = performance.now();
    const previousRequestAt = this.lastSeekRequestedAt;
    this.lastSeekRequestedAt = now;
    this.seekRequestCount += 1;
    this.patchDiagnostics({
      seekRequestCount: this.seekRequestCount,
      lastSeekIntervalMs: previousRequestAt === null ? undefined : now - previousRequestAt
    });
  }

  private recordSeekDropped(): void {
    this.seekDroppedCount += 1;
    this.patchDiagnostics({
      seekDroppedCount: this.seekDroppedCount
    });
  }

  private recordSeekCommit(transitionMs: number): void {
    this.seekCommitCount += 1;
    this.patchDiagnostics({
      seekCommitCount: this.seekCommitCount,
      seekDroppedCount: this.seekDroppedCount,
      lastSeekTransitionMs: transitionMs
    });
  }
}

function getAlphaSynthOutputModeAttempts(): AlphaSynthOutputMode[] {
  const outputModes = window.alphaSynth?.PlayerOutputMode;

  if (
    outputModes &&
    window.isSecureContext &&
    "AudioWorkletNode" in window &&
    typeof outputModes.WebAudioAudioWorklets === "number"
  ) {
    return ["audio-worklet", "script-processor"];
  }

  return ["script-processor"];
}

function getAlphaSynthOutputModeValue(outputMode: AlphaSynthOutputMode): number {
  const outputModes = window.alphaSynth?.PlayerOutputMode;

  if (outputMode === "audio-worklet") {
    return outputModes?.WebAudioAudioWorklets ?? 0;
  }

  return outputModes?.WebAudioScriptProcessor ?? 1;
}

function elapsedSince(startedAt: number | null): number | undefined {
  return startedAt === null ? undefined : Math.max(0, performance.now() - startedAt);
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
