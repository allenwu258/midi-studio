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

export function createScoreDraft({ song, shortestNote = "1/16" }: CreateScoreDraftInput): ScoreDraft {
  const diagnostics: ScoreDiagnostic[] = [];
  const measures = createMeasureMap(song.meta, diagnostics);
  const gridTicks = shortestNoteTicks(song.meta.ppq, shortestNote);
  const parts = song.tracks
    .filter((track) => track.noteCount > 0)
    .map((track) => createPart(song, track, gridTicks, diagnostics));

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
  track: ParsedTrack,
  gridTicks: number,
  diagnostics: ScoreDiagnostic[]
): ScorePart {
  const sourceNotes = song.notes.filter((note) => note.trackIndex === track.index);
  const averagePitch =
    sourceNotes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, sourceNotes.length);
  const clef = chooseClefForTrack(averagePitch, track.isDrum);
  const quantizedNotes = sourceNotes.map((note) => quantizeNote(note, gridTicks, 0));
  const chordEvents = createChordEvents(`part-${track.index}`, quantizedNotes, song.meta.ppq);
  const voiceCount = assignVoices(chordEvents, track.index, diagnostics);

  return {
    id: `part-${track.index}`,
    name: track.name || track.instrumentName || `Track ${track.index + 1}`,
    sourceTrackIndex: track.index,
    program: track.program,
    isDrum: track.isDrum,
    staves: [
      {
        index: 0,
        clef,
        voiceCount,
        events: chordEvents
      }
    ]
  };
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
