import type { MidiNote, ParsedSong, ParsedTrack } from "../midi";
import { durationNameFromTicks, quantizeTicks, shortestNoteTicks } from "./durations";
import { createMeasureMap } from "./measureMap";
import { chooseClefForTrack, spellMidiPitch } from "./pitchSpelling";
import type {
  CreateScoreDraftInput,
  QuantizedNote,
  ScoreChord,
  ScoreDiagnostic,
  ScoreDraft,
  ScoreEvent,
  ScorePart,
  ScoreRest
} from "./types";

const BASELINE_VOICE_LIMIT = 2;
const GRAND_STAFF_SPLIT_MIDI = 60;
const PIANO_PROGRAM_MIN = 0;
const PIANO_PROGRAM_MAX = 7;

type PartSource = {
  id: string;
  name: string;
  tracks: ParsedTrack[];
  notes: MidiNote[];
  program: number;
  isDrum: boolean;
};

export function createScoreDraft({ song, shortestNote = "1/16" }: CreateScoreDraftInput): ScoreDraft {
  const diagnostics: ScoreDiagnostic[] = [];
  const measures = createMeasureMap(song.meta, diagnostics);
  const gridTicks = shortestNoteTicks(song.meta.ppq, shortestNote);
  const parts = createPartSources(song).map((source) => createPart(song, source, gridTicks, diagnostics));

  if (!song.meta.keySignatures.length) {
    diagnostics.push({
      severity: "info",
      code: "MISSING_KEY_SIGNATURE",
      message: "MIDI 未提供调号，当前五线谱按 C 调基础拼写显示。"
    });
  }

  for (const part of parts) {
    for (const staff of part.staves) {
      staff.events = createStaffEvents(part.id, staff.index, staff.events as ScoreChord[], measures, song.meta.ppq);
    }
  }

  return {
    id: `score-${song.id}`,
    title: song.title,
    ppq: song.meta.ppq,
    durationMs: song.durationMs,
    durationTicks: song.meta.durationTicks,
    measures,
    parts,
    diagnostics
  };
}

function createPart(
  song: ParsedSong,
  source: PartSource,
  gridTicks: number,
  diagnostics: ScoreDiagnostic[]
): ScorePart {
  const sourceNotes = source.notes;
  const averagePitch =
    sourceNotes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, sourceNotes.length);
  const useGrandStaff = shouldUseGrandStaff(source);
  const quantizedNotes = sourceNotes.map((note) =>
    quantizeNote(note, gridTicks, useGrandStaff && note.midi < GRAND_STAFF_SPLIT_MIDI ? 1 : 0)
  );
  const chordEvents = createChordEvents(source.id, quantizedNotes, song.meta.ppq);
  const firstTrackIndex = source.tracks[0]?.index ?? 0;
  const trebleChords = chordEvents.filter((chord) => chord.staffIndex === 0);
  const bassChords = chordEvents.filter((chord) => chord.staffIndex === 1);
  const trebleVoiceCount = assignVoices(trebleChords, firstTrackIndex, diagnostics);
  const bassVoiceCount = assignVoices(bassChords, firstTrackIndex, diagnostics);
  const staves = useGrandStaff
    ? [
        {
          index: 0,
          clef: "treble" as const,
          voiceCount: trebleVoiceCount,
          events: trebleChords
        },
        {
          index: 1,
          clef: "bass" as const,
          voiceCount: bassVoiceCount,
          events: bassChords
        }
      ]
    : [
        {
          index: 0,
          clef: chooseClefForTrack(averagePitch, source.isDrum),
          voiceCount: trebleVoiceCount,
          events: trebleChords
        }
      ];

  return {
    id: source.id,
    name: source.name,
    sourceTrackIndex: firstTrackIndex,
    sourceTrackIndexes: source.tracks.map((track) => track.index),
    program: source.program,
    isDrum: source.isDrum,
    staves
  };
}

function createPartSources(song: ParsedSong): PartSource[] {
  const sources = new Map<string, PartSource>();

  for (const track of song.tracks.filter((item) => item.noteCount > 0)) {
    const notes = song.notes.filter((note) => note.trackIndex === track.index);
    const key = partSourceKey(track);
    const existing = sources.get(key);

    if (existing) {
      existing.tracks.push(track);
      existing.notes.push(...notes);
      existing.name = bestPartName(existing.name, track);
      continue;
    }

    sources.set(key, {
      id: `part-${sources.size}`,
      name: track.name || track.instrumentName || `Track ${track.index + 1}`,
      tracks: [track],
      notes,
      program: track.program,
      isDrum: track.isDrum
    });
  }

  return [...sources.values()].map((source) => ({
    ...source,
    notes: source.notes.sort((a, b) => a.startTicks - b.startTicks || a.midi - b.midi)
  }));
}

function partSourceKey(track: ParsedTrack): string {
  if (track.isDrum) {
    return `drum:${track.index}`;
  }

  if (isPianoProgram(track.program)) {
    return `piano:${track.program}`;
  }

  return `track:${track.index}`;
}

function bestPartName(currentName: string, track: ParsedTrack): string {
  const candidate = track.name || track.instrumentName;
  if (!candidate) {
    return currentName;
  }
  if (/^track\s+\d+$/i.test(currentName)) {
    return candidate;
  }
  return currentName;
}

function isPianoProgram(program: number): boolean {
  return program >= PIANO_PROGRAM_MIN && program <= PIANO_PROGRAM_MAX;
}

function shouldUseGrandStaff(source: PartSource): boolean {
  if (source.isDrum || source.notes.length === 0) {
    return false;
  }

  const pitches = source.notes.map((note) => note.midi);
  const minPitch = Math.min(...pitches);
  const maxPitch = Math.max(...pitches);

  return (
    isPianoProgram(source.program) ||
    source.tracks.length > 1 ||
    (minPitch < GRAND_STAFF_SPLIT_MIDI && maxPitch >= GRAND_STAFF_SPLIT_MIDI && maxPitch - minPitch >= 18)
  );
}

function quantizeNote(note: MidiNote, gridTicks: number, staffIndex: number): QuantizedNote {
  const quantizedStartTicks = quantizeTicks(note.startTicks, gridTicks);
  let quantizedEndTicks = quantizeTicks(note.endTicks, gridTicks);

  if (quantizedEndTicks <= quantizedStartTicks) {
    quantizedEndTicks = quantizedStartTicks + gridTicks;
  }

  return {
    ...note,
    quantizedStartTicks,
    quantizedEndTicks,
    staffIndex
  };
}

function createChordEvents(partId: string, notes: QuantizedNote[], ppq: number): ScoreChord[] {
  const grouped = new Map<string, QuantizedNote[]>();

  for (const note of notes) {
    const key = `${note.staffIndex}:${note.quantizedStartTicks}:${note.quantizedEndTicks}`;
    grouped.set(key, [...(grouped.get(key) ?? []), note]);
  }

  return [...grouped.entries()]
    .map(([key, group], index) => {
      const [staffIndexText, tickText, endTickText] = key.split(":");
      const startTicks = Number(tickText);
      const staffIndex = Number(staffIndexText);
      const endTicks = Number(endTickText);
      const duration = durationNameFromTicks(endTicks - startTicks, ppq);

      return {
        id: `${partId}-chord-${index}-${startTicks}`,
        partId,
        staffIndex,
        voiceIndex: 0,
        measureIndex: -1,
        kind: "chord",
        startTicks,
        endTicks,
        startMs: Math.min(...group.map((note) => note.startMs)),
        endMs: Math.max(...group.map((note) => note.endMs)),
        durationName: duration.name,
        dots: duration.dots,
        notes: group
          .sort((a, b) => a.midi - b.midi)
          .map((note) => ({
            ...spellMidiPitch(note.midi),
            sourceNoteId: note.id,
            velocity: note.velocity
          })),
        sourceNoteIds: group.map((note) => note.id),
        tieStart: false,
        tieStop: false
      } satisfies ScoreChord;
    })
    .sort((a, b) => a.startTicks - b.startTicks || a.notes[0].midi - b.notes[0].midi);
}

function assignVoices(
  chords: ScoreChord[],
  trackIndex: number,
  diagnostics: ScoreDiagnostic[]
): number {
  const voiceEndTicks = Array.from({ length: BASELINE_VOICE_LIMIT }, () => 0);
  let usedVoiceCount = 1;
  let reportedLimit = false;

  for (const chord of chords) {
    let voiceIndex = voiceEndTicks.findIndex((endTicks) => endTicks <= chord.startTicks);

    if (voiceIndex < 0) {
      voiceIndex = indexOfEarliestEndingVoice(voiceEndTicks);
      if (!reportedLimit) {
        diagnostics.push({
          severity: "warning",
          code: "VOICE_LIMIT_EXCEEDED",
          message: "检测到超过当前基础声部分离能力的复调片段，部分音符可能仍会重叠显示。",
          trackIndex,
          tick: chord.startTicks
        });
        reportedLimit = true;
      }
    }

    chord.voiceIndex = voiceIndex;
    voiceEndTicks[voiceIndex] = Math.max(voiceEndTicks[voiceIndex], chord.endTicks);
    usedVoiceCount = Math.max(usedVoiceCount, voiceIndex + 1);
  }

  return usedVoiceCount;
}

function indexOfEarliestEndingVoice(voiceEndTicks: number[]): number {
  let result = 0;
  for (let index = 1; index < voiceEndTicks.length; index += 1) {
    if (voiceEndTicks[index] < voiceEndTicks[result]) {
      result = index;
    }
  }
  return result;
}

function createStaffEvents(
  partId: string,
  staffIndex: number,
  chords: ScoreChord[],
  measures: ScoreDraft["measures"],
  ppq: number
): ScoreEvent[] {
  const events: ScoreEvent[] = [];

  for (const measure of measures) {
    const maxVoiceIndex = Math.max(0, ...chords.map((chord) => chord.voiceIndex));

    for (let voiceIndex = 0; voiceIndex <= maxVoiceIndex; voiceIndex += 1) {
      const measureChords = chords
        .filter(
          (chord) =>
            chord.voiceIndex === voiceIndex &&
            chord.startTicks < measure.endTicks &&
            chord.endTicks > measure.startTicks
        )
        .map((chord) => clipChordToMeasure(chord, measure.index, measure.startTicks, measure.endTicks, ppq))
        .sort((a, b) => a.startTicks - b.startTicks);

      let cursor = measure.startTicks;
      for (const chord of measureChords) {
        if (chord.startTicks > cursor) {
          events.push(createRest(partId, staffIndex, voiceIndex, measure.index, cursor, chord.startTicks, ppq));
        }
        events.push(chord);
        cursor = Math.max(cursor, chord.endTicks);
      }

      if (cursor < measure.endTicks) {
        events.push(createRest(partId, staffIndex, voiceIndex, measure.index, cursor, measure.endTicks, ppq));
      }
    }
  }

  return events;
}

function clipChordToMeasure(
  chord: ScoreChord,
  measureIndex: number,
  measureStartTicks: number,
  measureEndTicks: number,
  ppq: number
): ScoreChord {
  const startTicks = Math.max(chord.startTicks, measureStartTicks);
  const endTicks = Math.min(chord.endTicks, measureEndTicks);
  const duration = durationNameFromTicks(endTicks - startTicks, ppq);
  const ratioStart = (startTicks - chord.startTicks) / Math.max(1, chord.endTicks - chord.startTicks);
  const ratioEnd = (endTicks - chord.startTicks) / Math.max(1, chord.endTicks - chord.startTicks);
  const msRange = chord.endMs - chord.startMs;

  return {
    ...chord,
    id: `${chord.id}-m${measureIndex}-${startTicks}`,
    measureIndex,
    startTicks,
    endTicks,
    startMs: chord.startMs + msRange * ratioStart,
    endMs: chord.startMs + msRange * ratioEnd,
    durationName: duration.name,
    dots: duration.dots,
    tieStop: startTicks > chord.startTicks,
    tieStart: endTicks < chord.endTicks
  };
}

function createRest(
  partId: string,
  staffIndex: number,
  voiceIndex: number,
  measureIndex: number,
  startTicks: number,
  endTicks: number,
  ppq: number
): ScoreRest {
  const duration = durationNameFromTicks(endTicks - startTicks, ppq);

  return {
    id: `${partId}-rest-${staffIndex}-${measureIndex}-${startTicks}`,
    partId,
    staffIndex,
    voiceIndex,
    measureIndex,
    kind: "rest",
    startTicks,
    endTicks,
    startMs: 0,
    endMs: 0,
    durationName: duration.name,
    dots: duration.dots
  };
}
