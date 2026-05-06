import { Midi } from "@tonejs/midi";
import { midiToNumberedNotation, normalizeKeyName } from "./notation";

export type MidiNote = {
  id: string;
  midi: number;
  name: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  velocity: number;
  trackIndex: number;
  trackName: string;
  notation: string;
};

export type NoteCluster = {
  id: string;
  startMs: number;
  endMs: number;
  notes: MidiNote[];
  label: string;
};

export type ParsedSong = {
  id: string;
  fileName: string;
  title: string;
  keyName: string;
  bpm: number | null;
  durationMs: number;
  trackCount: number;
  noteCount: number;
  notes: MidiNote[];
  clusters: NoteCluster[];
};

export function parseMidiFile(buffer: ArrayBuffer, fileName: string): ParsedSong {
  const midi = new Midi(buffer);
  const keyName = normalizeKeyName(midi.header.keySignatures[0]?.key);
  const title = midi.name || fileName.replace(/\.(mid|midi)$/i, "") || "Untitled MIDI";
  const notes = midi.tracks.flatMap((track, trackIndex) =>
    track.notes.map((note, noteIndex) => {
      const startMs = note.time * 1000;
      const durationMs = Math.max(40, note.duration * 1000);
      const endMs = startMs + durationMs;

      return {
        id: `${trackIndex}-${noteIndex}-${note.midi}-${Math.round(startMs)}`,
        midi: note.midi,
        name: note.name,
        startMs,
        durationMs,
        endMs,
        velocity: note.velocity,
        trackIndex,
        trackName: track.name || `Track ${trackIndex + 1}`,
        notation: midiToNumberedNotation(note.midi, keyName)
      };
    })
  );

  notes.sort((a, b) => a.startMs - b.startMs || a.midi - b.midi);

  if (!notes.length) {
    throw new Error("这个 MIDI 没有可播放的音符事件。");
  }

  const durationMs = Math.max(midi.duration * 1000, ...notes.map((note) => note.endMs));

  return {
    id: `${fileName}-${Date.now()}`,
    fileName,
    title,
    keyName,
    bpm: midi.header.tempos[0]?.bpm ?? null,
    durationMs,
    trackCount: midi.tracks.length,
    noteCount: notes.length,
    notes,
    clusters: createNoteClusters(notes)
  };
}

function createNoteClusters(notes: MidiNote[]): NoteCluster[] {
  const clusters: NoteCluster[] = [];
  let current: MidiNote[] = [];
  let currentStart = -1;
  const chordToleranceMs = 35;

  for (const note of notes) {
    if (!current.length || Math.abs(note.startMs - currentStart) <= chordToleranceMs) {
      if (!current.length) {
        currentStart = note.startMs;
      }
      current.push(note);
      continue;
    }

    clusters.push(toCluster(current, clusters.length));
    current = [note];
    currentStart = note.startMs;
  }

  if (current.length) {
    clusters.push(toCluster(current, clusters.length));
  }

  return clusters;
}

function toCluster(notes: MidiNote[], index: number): NoteCluster {
  const sorted = [...notes].sort((a, b) => a.midi - b.midi);
  const startMs = Math.min(...sorted.map((note) => note.startMs));
  const endMs = Math.max(...sorted.map((note) => note.endMs), startMs + 120);
  const label =
    sorted.length > 1
      ? `[${sorted.map((note) => note.notation).join(" ")}]`
      : sorted[0].notation;

  return {
    id: `cluster-${index}-${Math.round(startMs)}`,
    startMs,
    endMs,
    notes: sorted,
    label
  };
}
