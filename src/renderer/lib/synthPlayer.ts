import type { MidiNote } from "./midi";

type PlayerStatus = "idle" | "playing" | "paused" | "ended";

export type PlayerSnapshot = {
  status: PlayerStatus;
  positionMs: number;
  durationMs: number;
};

type ScheduledVoice = {
  oscillator: OscillatorNode;
  gain: GainNode;
};

export class SynthPlayer {
  private audioContext: AudioContext | null = null;
  private notes: MidiNote[] = [];
  private durationMs = 0;
  private positionMs = 0;
  private speed = 1;
  private status: PlayerStatus = "idle";
  private playStartedAt = 0;
  private playStartedPosition = 0;
  private nextNoteIndex = 0;
  private schedulerId = 0;
  private scheduledVoices = new Set<ScheduledVoice>();
  private listeners = new Set<(snapshot: PlayerSnapshot) => void>();

  load(notes: MidiNote[], durationMs: number): void {
    this.stopScheduler();
    this.stopVoices();
    this.notes = notes;
    this.durationMs = durationMs;
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

    this.status = "playing";
    this.playStartedAt = context.currentTime;
    this.playStartedPosition = this.positionMs;
    this.nextNoteIndex = this.findNextNoteIndex(this.positionMs);
    this.startScheduler();
    this.emit();
  }

  pause(): void {
    if (this.status !== "playing") {
      return;
    }

    this.positionMs = this.getPositionMs();
    this.status = "paused";
    this.stopScheduler();
    this.stopVoices();
    this.emit();
  }

  stop(): void {
    this.stopScheduler();
    this.stopVoices();
    this.positionMs = 0;
    this.status = "idle";
    this.nextNoteIndex = 0;
    this.emit();
  }

  seek(positionMs: number): void {
    const nextPosition = Math.max(0, Math.min(positionMs, this.durationMs));
    const wasPlaying = this.status === "playing";

    this.stopScheduler();
    this.stopVoices();
    this.positionMs = nextPosition;
    this.nextNoteIndex = this.findNextNoteIndex(nextPosition);

    if (wasPlaying && this.audioContext) {
      this.playStartedAt = this.audioContext.currentTime;
      this.playStartedPosition = this.positionMs;
      this.startScheduler();
    }

    this.emit();
  }

  setSpeed(percent: number): void {
    const nextSpeed = Math.max(0.1, Math.min(percent / 100, 2));
    const currentPosition = this.getPositionMs();

    this.speed = nextSpeed;
    this.seek(currentPosition);
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

  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
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
    const durationSeconds = Math.max(0.03, remainingMs / 1000 / this.speed);
    const endAt = startAt + durationSeconds;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const voice = { oscillator, gain };
    const velocity = Math.max(0.08, Math.min(note.velocity || 0.6, 1));

    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(midiToFrequency(note.midi), startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.18 * velocity, startAt + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.08 * velocity, Math.max(startAt + 0.03, endAt - 0.08));
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt + 0.05);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(startAt);
    oscillator.stop(endAt + 0.08);

    this.scheduledVoices.add(voice);
    oscillator.addEventListener("ended", () => {
      this.scheduledVoices.delete(voice);
      oscillator.disconnect();
      gain.disconnect();
    });
  }

  private stopVoices(): void {
    for (const voice of this.scheduledVoices) {
      try {
        voice.oscillator.stop();
      } catch {
        // The voice may already be stopped; either state is fine here.
      }
      voice.oscillator.disconnect();
      voice.gain.disconnect();
    }
    this.scheduledVoices.clear();
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
    this.stopVoices();
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
}

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
