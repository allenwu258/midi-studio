import { Midi } from "@tonejs/midi";

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
  startTicks: number;
  durationTicks: number;
  endTicks: number;
  channel: number;
  program: number;
  instrumentName: string;
  isDrum: boolean;
  tieStart?: boolean;
  tieStop?: boolean;
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
  tracks: ParsedTrack[];
  meta: ParsedMidiMeta;
};

export type ParsedTrack = {
  index: number;
  name: string;
  channel: number;
  program: number;
  instrumentName: string;
  isDrum: boolean;
  noteCount: number;
};

export type ParsedMidiMeta = {
  ppq: number;
  durationTicks: number;
  tempos: Array<{ ticks: number; bpm: number }>;
  timeSignatures: Array<{ ticks: number; numerator: number; denominator: number }>;
  keySignatures: Array<{ ticks: number; key: string; scale: string }>;
};

export function parseMidiFile(buffer: ArrayBuffer, fileName: string): ParsedSong {
  const midi = new Midi(buffer);
  const keyName = normalizeKeyName(midi.header.keySignatures[0]?.key);
  const title = midi.name || fileName.replace(/\.(mid|midi)$/i, "") || "Untitled MIDI";
  const tracks: ParsedTrack[] = midi.tracks.map((track, trackIndex) => ({
    index: trackIndex,
    name: track.name || `Track ${trackIndex + 1}`,
    channel: track.channel,
    program: track.instrument.number,
    instrumentName: track.instrument.name,
    isDrum: track.instrument.percussion || track.channel === 9,
    noteCount: track.notes.length
  }));
  const notes = midi.tracks.flatMap((track, trackIndex) => {
    const parsedTrack = tracks[trackIndex];

    return track.notes.map((note, noteIndex) => {
      const startMs = note.time * 1000;
      const durationMs = Math.max(40, note.duration * 1000);
      const endMs = startMs + durationMs;
      const durationTicks = Math.max(1, note.durationTicks);
      const endTicks = note.ticks + durationTicks;

      return {
        id: `${trackIndex}-${noteIndex}-${note.midi}-${Math.round(startMs)}`,
        midi: note.midi,
        name: note.name,
        startMs,
        durationMs,
        endMs,
        velocity: note.velocity,
        trackIndex,
        trackName: parsedTrack.name,
        startTicks: note.ticks,
        durationTicks,
        endTicks,
        channel: parsedTrack.channel,
        program: parsedTrack.program,
        instrumentName: parsedTrack.instrumentName,
        isDrum: parsedTrack.isDrum
      };
    });
  });

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
    tracks,
    meta: {
      ppq: midi.header.ppq,
      durationTicks: Math.max(midi.durationTicks, ...notes.map((note) => note.endTicks)),
      tempos: midi.header.tempos.map((tempo) => ({
        ticks: tempo.ticks,
        bpm: tempo.bpm
      })),
      timeSignatures: midi.header.timeSignatures.map((timeSignature) => ({
        ticks: timeSignature.ticks,
        numerator: timeSignature.timeSignature[0] ?? 4,
        denominator: timeSignature.timeSignature[1] ?? 4
      })),
      keySignatures: midi.header.keySignatures.map((keySignature) => ({
        ticks: keySignature.ticks,
        key: keySignature.key,
        scale: keySignature.scale
      }))
    }
  };
}

function normalizeKeyName(key?: string): string {
  if (!key) {
    return "C";
  }

  const trimmed = key.trim();
  return trimmed || "C";
}
