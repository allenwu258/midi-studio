import type { ParsedSong } from "../midi";

type MidiTrackEvent = {
  tick: number;
  type: "meta" | "program" | "note-on" | "note-off";
  channel?: number;
  data?: number[];
  metaType?: number;
  metaData?: number[];
  order: number;
};

const DEFAULT_TEMPO_BPM = 120;

export function buildMidiBytes(song: ParsedSong): ArrayBuffer {
  const trackChunks: Uint8Array[] = [];
  trackChunks.push(buildConductorTrack(song));

  for (const track of song.tracks) {
    trackChunks.push(buildPartTrack(song, track.index));
  }

  const chunks: number[] = [];
  chunks.push(...asciiBytes("MThd"));
  chunks.push(0x00, 0x00, 0x00, 0x06);
  chunks.push(0x00, 0x01);
  chunks.push(...u16(trackChunks.length));
  chunks.push(...u16(song.meta.ppq));

  for (const chunk of trackChunks) {
    chunks.push(...chunk);
  }

  return Uint8Array.from(chunks).buffer;
}

function buildConductorTrack(song: ParsedSong): Uint8Array {
  const events: MidiTrackEvent[] = [];
  const tempos = song.meta.tempos.length ? song.meta.tempos : [{ ticks: 0, bpm: song.bpm ?? DEFAULT_TEMPO_BPM }];
  const timeSignatures = song.meta.timeSignatures.length
    ? song.meta.timeSignatures
    : [{ ticks: 0, numerator: 4, denominator: 4 }];
  const keySignatures = song.meta.keySignatures.length ? song.meta.keySignatures : [{ ticks: 0, key: "C", scale: "major" }];

  for (const tempo of tempos) {
    const microsecondsPerQuarter = Math.max(1, Math.round(60000000 / Math.max(1, tempo.bpm)));
    events.push({
      tick: tempo.ticks,
      type: "meta",
      metaType: 0x51,
      metaData: [(microsecondsPerQuarter >> 16) & 0xff, (microsecondsPerQuarter >> 8) & 0xff, microsecondsPerQuarter & 0xff],
      order: 0
    });
  }

  for (const signature of timeSignatures) {
    events.push({
      tick: signature.ticks,
      type: "meta",
      metaType: 0x58,
      metaData: [
        signature.numerator & 0xff,
        Math.max(0, Math.round(Math.log2(Math.max(1, signature.denominator)))) & 0xff,
        24,
        8
      ],
      order: 1
    });
  }

  for (const signature of keySignatures) {
    const { fifths, mode } = keySignatureToMidi(signature.key, signature.scale);
    events.push({
      tick: signature.ticks,
      type: "meta",
      metaType: 0x59,
      metaData: [fifths & 0xff, mode],
      order: 2
    });
  }

  return encodeTrack(events, song.meta.durationTicks);
}

function buildPartTrack(song: ParsedSong, trackIndex: number): Uint8Array {
  const track = song.tracks[trackIndex];
  const notes = song.notes.filter((note) => note.trackIndex === trackIndex);
  const events: MidiTrackEvent[] = [];

  events.push({
    tick: 0,
    type: "program",
    channel: track.channel & 0x0f,
    data: [track.program & 0x7f],
    order: 0
  });

  for (const note of notes) {
    const channel = track.channel & 0x0f;
    const pitch = clampMidi(note.midi);
    events.push({
      tick: note.startTicks,
      type: "note-on",
      channel,
      data: [pitch, clampVelocity(note.velocity)],
      order: 2
    });
    events.push({
      tick: note.endTicks,
      type: "note-off",
      channel,
      data: [pitch, 0],
      order: 1
    });
  }

  return encodeTrack(events, song.meta.durationTicks);
}

function encodeTrack(events: MidiTrackEvent[], endTick: number): Uint8Array {
  const encoded: number[] = [];
  encoded.push(...asciiBytes("MTrk"));

  const body: number[] = [];
  let lastTick = 0;
  let runningStatus: number | null = null;

  for (const event of [...events].sort(compareMidiEvent)) {
    const delta = Math.max(0, event.tick - lastTick);
    body.push(...encodeVarLength(delta));
    lastTick = event.tick;

    if (event.type === "meta" && event.metaType !== undefined && event.metaData) {
      body.push(0xff, event.metaType, event.metaData.length, ...event.metaData);
      runningStatus = null;
      continue;
    }

    if (event.type === "program" && event.channel !== undefined && event.data) {
      const status = 0xc0 | (event.channel & 0x0f);
      if (runningStatus !== status) {
        body.push(status);
        runningStatus = status;
      }
      body.push(event.data[0] ?? 0);
      continue;
    }

    if ((event.type === "note-on" || event.type === "note-off") && event.channel !== undefined && event.data) {
      const status = (event.type === "note-on" ? 0x90 : 0x80) | (event.channel & 0x0f);
      if (runningStatus !== status) {
        body.push(status);
        runningStatus = status;
      }
      body.push(event.data[0] ?? 0, event.data[1] ?? 0);
      continue;
    }
  }

  body.push(...encodeVarLength(Math.max(0, endTick - lastTick)), 0xff, 0x2f, 0x00);

  encoded.push(...u32(body.length));
  encoded.push(...body);

  return Uint8Array.from(encoded);
}

function compareMidiEvent(a: MidiTrackEvent, b: MidiTrackEvent): number {
  if (a.tick !== b.tick) {
    return a.tick - b.tick;
  }

  return a.order - b.order;
}

function keySignatureToMidi(key: string, scale: string): { fifths: number; mode: number } {
  const normalizedKey = key.trim().replace(/♭/g, "b").replace(/♯/g, "#");
  const lookup: Record<string, number> = {
    C: 0,
    G: 1,
    D: 2,
    A: 3,
    E: 4,
    B: 5,
    "F#": 6,
    "C#": 7,
    F: -1,
    Bb: -2,
    Eb: -3,
    Ab: -4,
    Db: -5,
    Gb: -6,
    Cb: -7
  };

  return {
    fifths: lookup[normalizedKey] ?? 0,
    mode: scale.toLowerCase().startsWith("minor") ? 1 : 0
  };
}

function clampMidi(value: number): number {
  return Math.max(0, Math.min(127, Math.round(value)));
}

function clampVelocity(value: number): number {
  return Math.max(1, Math.min(127, Math.round(value)));
}

function encodeVarLength(value: number): number[] {
  let buffer = value & 0x7f;
  const bytes: number[] = [];

  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= ((value & 0x7f) | 0x80);
  }

  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) {
      buffer >>= 8;
    } else {
      break;
    }
  }

  return bytes;
}

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function asciiBytes(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0) & 0xff);
}
