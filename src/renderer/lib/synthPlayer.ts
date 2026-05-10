import type { MidiNote } from "./midi";
import type {
  MidiPlaybackEngine,
  PlayerDiagnostics,
  PlayerLoadInput,
  PlayerSeekOptions,
  PlayerSnapshot,
  PlayerStatus
} from "./player/types";

type ScheduledVoice = {
  oscillator: OscillatorNode;
  gain: GainNode;
  startAt: number;
  disconnected: boolean;
};

const SEEK_FADE_OUT_MS = 60;
const SEEK_FADE_IN_MS = 90;
const SEEK_REPOSITION_DELAY_MS = 70;
const VOICE_RELEASE_MS = 55;
const SEEK_SETTLE_MS = VOICE_RELEASE_MS;
const TRANSPORT_FADE_IN_MS = 35;
const TRANSPORT_FADE_OUT_MS = 45;
const MIN_GAIN = 0.0001;

export class SynthPlayer implements MidiPlaybackEngine {
  private audioContext: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private notes: MidiNote[] = [];
  private durationMs = 0;
  private positionMs = 0;
  private speed = 1;
  private masterVolume = 1;
  private status: PlayerStatus = "idle";
  private playStartedAt = 0;
  private playStartedPosition = 0;
  private nextNoteIndex = 0;
  private schedulerId = 0;
  private seekTimerId = 0;
  private seekTransitionId = 0;
  private transportTransitionId = 0;
  private pendingSeekPositionMs: number | null = null;
  private activeSeekTransitionId: number | null = null;
  private activeTransportTransitionId: number | null = null;
  private lastSeekRequestedAt: number | null = null;
  private scheduledVoices = new Set<ScheduledVoice>();
  private releasingVoices = new Set<ScheduledVoice>();
  private listeners = new Set<(snapshot: PlayerSnapshot) => void>();
  private diagnosticsListeners = new Set<(diagnostics: PlayerDiagnostics) => void>();
  private diagnostics: PlayerDiagnostics = {
    engine: "basic-midi",
    outputMode: "pure-web-audio"
  };
  private seekRequestCount = 0;
  private seekCommitCount = 0;
  private seekDroppedCount = 0;

  load(input: PlayerLoadInput): void {
    this.cancelSeekTransition({ restoreVolume: true, countDropped: false });
    this.stopScheduler();
    this.stopVoicesImmediately();
    this.notes = input.notes;
    this.durationMs = input.durationMs;
    this.positionMs = 0;
    this.speed = 1;
    this.status = "idle";
    this.nextNoteIndex = 0;
    this.emit();
  }

  async play(): Promise<void> {
    if (!this.notes.length) {
      return;
    }

    const context = this.getAudioContext();
    if (context.state === "suspended") {
      await context.resume();
    }

    if (this.positionMs >= this.durationMs) {
      this.positionMs = 0;
    }

    const transportTransitionId = this.beginTransportTransition();
    this.prepareMasterGainForStart();
    this.stopVoicesImmediately();
    this.status = "playing";
    this.playStartedAt = context.currentTime;
    this.playStartedPosition = this.positionMs;
    this.nextNoteIndex = this.findNextNoteIndex(this.positionMs);
    this.startScheduler();
    this.rampMasterGainTo(this.masterVolume, TRANSPORT_FADE_IN_MS);
    window.setTimeout(() => {
      this.finishTransportTransition(transportTransitionId, true);
    }, TRANSPORT_FADE_IN_MS);
    this.emit();
  }

  pause(): void {
    if (this.status !== "playing") {
      return;
    }

    this.cancelSeekTransition({ restoreVolume: true, countDropped: true });
    this.positionMs = this.getPositionMs();
    this.status = "paused";
    this.stopScheduler();
    const transportTransitionId = this.beginTransportTransition();
    this.rampMasterGainTo(MIN_GAIN, TRANSPORT_FADE_OUT_MS);
    this.releaseVoices(Math.max(VOICE_RELEASE_MS, TRANSPORT_FADE_OUT_MS));
    window.setTimeout(() => {
      this.finishTransportTransition(transportTransitionId, false);
    }, Math.max(VOICE_RELEASE_MS, TRANSPORT_FADE_OUT_MS));
    this.emit();
  }

  stop(): void {
    this.cancelSeekTransition({ restoreVolume: true, countDropped: true });
    this.stopScheduler();
    const transportTransitionId = this.beginTransportTransition();
    this.rampMasterGainTo(MIN_GAIN, TRANSPORT_FADE_OUT_MS);
    this.releaseVoices(Math.max(VOICE_RELEASE_MS, TRANSPORT_FADE_OUT_MS));
    this.positionMs = 0;
    this.status = "idle";
    this.nextNoteIndex = 0;
    window.setTimeout(() => {
      this.finishTransportTransition(transportTransitionId, false);
    }, Math.max(VOICE_RELEASE_MS, TRANSPORT_FADE_OUT_MS));
    this.emit();
  }

  seek(positionMs: number, options: PlayerSeekOptions = {}): void {
    const nextPosition = Math.max(0, Math.min(positionMs, this.durationMs));
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
    const nextSpeed = Math.max(0.1, Math.min(percent / 100, 2));
    const currentPosition = this.getPositionMs();

    this.speed = nextSpeed;
    this.cancelSeekTransition({ restoreVolume: true, countDropped: false });
    this.repositionAfterSpeedChange(currentPosition);
  }

  setMasterVolume(percent: number): void {
    this.masterVolume = clampVolume(percent);
    if (
      this.pendingSeekPositionMs !== null ||
      this.seekTimerId ||
      this.activeSeekTransitionId !== null ||
      this.activeTransportTransitionId !== null
    ) {
      return;
    }

    this.applyMasterGainTarget();
  }

  getSnapshot(): PlayerSnapshot {
    const positionMs = this.getPositionMs();
    return {
      status: this.status,
      positionMs,
      durationMs: this.durationMs
    };
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

  dispose(): void {
    this.cancelSeekTransition({ restoreVolume: false, countDropped: false });
    this.stopScheduler();
    this.stopVoicesImmediately();
    this.positionMs = 0;
    this.status = "idle";
    this.listeners.clear();
    this.diagnosticsListeners.clear();
    void this.audioContext?.close();
    this.audioContext = null;
    this.masterGain = null;
  }

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.audioContext.destination);
    }
    return this.audioContext;
  }

  private getPositionMs(): number {
    if (this.status !== "playing" || !this.audioContext) {
      return this.positionMs;
    }

    const elapsedMs = (this.audioContext.currentTime - this.playStartedAt) * 1000 * this.speed;
    const position = Math.min(this.playStartedPosition + elapsedMs, this.durationMs);

    if (position >= this.durationMs) {
      window.setTimeout(() => this.finishIfNeeded(), 0);
    }

    return position;
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.schedulerId = window.setInterval(() => this.scheduleAhead(), 75);
    this.scheduleAhead();
  }

  private stopScheduler(): void {
    if (this.schedulerId) {
      window.clearInterval(this.schedulerId);
      this.schedulerId = 0;
    }
  }

  private commitSeek(positionMs: number, smooth: boolean, diagnostic: boolean): void {
    const wasPlaying = this.status === "playing";
    const context = this.audioContext;
    const transitionId = ++this.seekTransitionId;
    const startedAt = performance.now();

    this.stopScheduler();

    if (smooth && wasPlaying && context) {
      this.activeSeekTransitionId = transitionId;
      this.rampMasterGainTo(MIN_GAIN, SEEK_FADE_OUT_MS);
      this.releaseVoices(VOICE_RELEASE_MS);

      window.setTimeout(() => {
        if (transitionId !== this.seekTransitionId) {
          return;
        }

        if (this.status !== "playing") {
          this.abortActiveSeekTransition(transitionId, {
            restoreVolume: true,
            countDropped: diagnostic
          });
          return;
        }

        this.applySeekPosition(positionMs, wasPlaying);

        window.setTimeout(() => {
          if (transitionId !== this.seekTransitionId) {
            return;
          }

          if (this.status !== "playing") {
            this.abortActiveSeekTransition(transitionId, {
              restoreVolume: true,
              countDropped: diagnostic
            });
            return;
          }

          this.rampMasterGainTo(this.masterVolume, SEEK_FADE_IN_MS);
          window.setTimeout(() => {
            if (this.activeSeekTransitionId === transitionId) {
              this.activeSeekTransitionId = null;
              this.applyMasterGainTarget();
              if (diagnostic) {
                this.recordSeekCommit(performance.now() - startedAt);
              }
            }
          }, SEEK_FADE_IN_MS);
        }, SEEK_SETTLE_MS);
      }, SEEK_REPOSITION_DELAY_MS);
      return;
    }

    this.stopVoicesImmediately();
    this.applySeekPosition(positionMs, wasPlaying);
    if (diagnostic) {
      this.recordSeekCommit(performance.now() - startedAt);
    }
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
      this.restoreMasterGain();
    }
  }

  private repositionAfterSpeedChange(positionMs: number): void {
    const wasPlaying = this.status === "playing";
    this.stopScheduler();
    this.releaseVoices(VOICE_RELEASE_MS);
    this.applySeekPosition(positionMs, wasPlaying);
  }

  private applySeekPosition(positionMs: number, resumePlayback: boolean): void {
    this.positionMs = positionMs;
    this.nextNoteIndex = this.findNextNoteIndex(positionMs);

    if (resumePlayback && this.audioContext) {
      this.playStartedAt = this.audioContext.currentTime;
      this.playStartedPosition = this.positionMs;
      this.startScheduler();
    }

    this.emit();
  }

  private scheduleAhead(): void {
    if (this.status !== "playing") {
      return;
    }

    const context = this.getAudioContext();
    const positionMs = this.getPositionMs();
    const lookAheadMs = 450;

    while (
      this.nextNoteIndex < this.notes.length &&
      this.notes[this.nextNoteIndex].startMs < positionMs + lookAheadMs
    ) {
      const note = this.notes[this.nextNoteIndex];
      if (note.endMs > positionMs) {
        this.scheduleNote(context, note, positionMs);
      }
      this.nextNoteIndex += 1;
    }

    if (positionMs >= this.durationMs) {
      this.finishIfNeeded();
    }
  }

  private scheduleNote(context: AudioContext, note: MidiNote, positionMs: number): void {
    const startDelayMs = Math.max(0, note.startMs - positionMs);
    const audibleStartMs = Math.max(positionMs, note.startMs);
    const remainingMs = Math.max(0, note.endMs - audibleStartMs);
    const startAt = context.currentTime + startDelayMs / 1000 / this.speed;
    const durationSeconds = Math.max(0.06, remainingMs / 1000 / this.speed);
    const endAt = startAt + durationSeconds;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const voice = { oscillator, gain, startAt, disconnected: false };
    const velocity = Math.max(0.08, Math.min(note.velocity || 0.6, 1));
    const attackSeconds = Math.min(0.018, Math.max(0.008, durationSeconds * 0.2));
    const releaseSeconds = Math.min(0.09, Math.max(0.045, durationSeconds * 0.35));
    const decayStartAt = startAt + attackSeconds;
    const releaseStartAt = Math.max(decayStartAt + 0.008, endAt - releaseSeconds);

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(midiToFrequency(note.midi), startAt);
    gain.gain.setValueAtTime(MIN_GAIN, startAt);
    gain.gain.linearRampToValueAtTime(0.16 * velocity, decayStartAt);
    gain.gain.linearRampToValueAtTime(0.075 * velocity, releaseStartAt);
    gain.gain.linearRampToValueAtTime(MIN_GAIN, endAt);

    oscillator.connect(gain);
    gain.connect(this.getMasterGain(context));
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.03);

    this.scheduledVoices.add(voice);
    oscillator.addEventListener("ended", () => {
      this.scheduledVoices.delete(voice);
      this.releasingVoices.delete(voice);
      this.disconnectVoice(voice);
    });
  }

  private releaseVoices(releaseMs: number): void {
    if (!this.audioContext) {
      this.stopVoicesImmediately();
      return;
    }

    const now = this.audioContext.currentTime;
    const releaseSeconds = Math.max(0.005, releaseMs / 1000);

    for (const voice of [...this.scheduledVoices]) {
      this.scheduledVoices.delete(voice);
      if (voice.startAt > now) {
        this.stopVoiceImmediately(voice);
        continue;
      }

      this.releasingVoices.add(voice);
      try {
        const currentGain = Math.max(MIN_GAIN, voice.gain.gain.value || MIN_GAIN);
        holdGainAtCurrentTime(voice.gain.gain, now, currentGain);
        voice.gain.gain.linearRampToValueAtTime(MIN_GAIN, now + releaseSeconds);
        voice.oscillator.stop(now + releaseSeconds + 0.02);
      } catch {
        this.stopVoiceImmediately(voice);
      }
    }
  }

  private stopVoicesImmediately(): void {
    for (const voice of [...this.scheduledVoices, ...this.releasingVoices]) {
      this.stopVoiceImmediately(voice);
    }
    this.scheduledVoices.clear();
    this.releasingVoices.clear();
  }

  private stopVoiceImmediately(voice: ScheduledVoice): void {
    try {
      voice.oscillator.stop();
    } catch {
      // The voice may already be stopped; either state is fine here.
    }
    this.disconnectVoice(voice);
    this.scheduledVoices.delete(voice);
    this.releasingVoices.delete(voice);
  }

  private disconnectVoice(voice: ScheduledVoice): void {
    if (voice.disconnected) {
      return;
    }

    voice.disconnected = true;
    voice.oscillator.disconnect();
    voice.gain.disconnect();
  }

  private rampMasterGainTo(targetGain: number, durationMs: number): void {
    if (!this.audioContext || !this.masterGain) {
      return;
    }

    const now = this.audioContext.currentTime;
    holdGainAtCurrentTime(this.masterGain.gain, now, this.masterGain.gain.value);
    this.masterGain.gain.linearRampToValueAtTime(Math.max(0, targetGain), now + durationMs / 1000);
  }

  private restoreMasterGain(): void {
    if (!this.audioContext || !this.masterGain) {
      return;
    }

    const now = this.audioContext.currentTime;
    holdGainAtCurrentTime(this.masterGain.gain, now, this.masterGain.gain.value);
    this.masterGain.gain.linearRampToValueAtTime(this.masterVolume, now + SEEK_FADE_IN_MS / 1000);
  }

  private beginTransportTransition(): number {
    const transitionId = ++this.transportTransitionId;
    this.activeTransportTransitionId = transitionId;
    return transitionId;
  }

  private finishTransportTransition(transitionId: number, applyLatestVolume: boolean): void {
    if (this.activeTransportTransitionId !== transitionId) {
      return;
    }

    this.activeTransportTransitionId = null;
    if (applyLatestVolume) {
      this.applyMasterGainTarget();
    }
  }

  private prepareMasterGainForStart(): void {
    if (!this.audioContext || !this.masterGain) {
      return;
    }

    const now = this.audioContext.currentTime;
    holdGainAtCurrentTime(this.masterGain.gain, now, this.masterGain.gain.value);
    this.masterGain.gain.setValueAtTime(MIN_GAIN, now);
  }

  private applyMasterGainTarget(): void {
    this.masterGain?.gain.setTargetAtTime(
      this.masterVolume,
      this.audioContext?.currentTime ?? 0,
      0.01
    );
  }

  private getMasterGain(context: AudioContext): GainNode {
    if (!this.masterGain) {
      this.masterGain = context.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(context.destination);
    }

    return this.masterGain;
  }

  private findNextNoteIndex(positionMs: number): number {
    const index = this.notes.findIndex((note) => note.endMs >= positionMs);
    return index < 0 ? this.notes.length : index;
  }

  private finishIfNeeded(): void {
    if (this.status !== "playing") {
      return;
    }

    const position = this.getPositionMs();
    if (position < this.durationMs) {
      return;
    }

    this.stopScheduler();
    this.releaseVoices(VOICE_RELEASE_MS);
    this.positionMs = this.durationMs;
    this.status = "ended";
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
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
      this.restoreMasterGain();
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

  private patchDiagnostics(patch: Partial<PlayerDiagnostics>): void {
    this.diagnostics = {
      ...this.diagnostics,
      ...patch
    };
    this.emitDiagnostics();
  }

  private emitDiagnostics(): void {
    for (const listener of this.diagnosticsListeners) {
      listener(this.diagnostics);
    }
  }
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function clampVolume(percent: number): number {
  return Math.max(0, Math.min(percent / 100, 1));
}

function holdGainAtCurrentTime(param: AudioParam, now: number, fallbackValue: number): void {
  if ("cancelAndHoldAtTime" in param && typeof param.cancelAndHoldAtTime === "function") {
    param.cancelAndHoldAtTime(now);
    return;
  }

  param.cancelScheduledValues(now);
  param.setValueAtTime(Math.max(0, fallbackValue), now);
}
