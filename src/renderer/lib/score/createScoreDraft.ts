import type { MidiNote, ParsedSong, ParsedTrack } from "../midi";
import { durationNameFromTicks, shortestNoteTicks } from "./durations";
import { createMeasureMap } from "./measureMap";
import { assignPianoStaves } from "./pianoSplit";
import { chooseClefForTrack, createPitchSpellings } from "./pitchSpelling";
import { quantizeNotesWithContext } from "./quantization";
import { spellChordIntoMeasure, spellRestIntoMeasure } from "./rhythmSpelling";
import { assignVoices } from "./voices";
import type {
  CreateScoreDraftInput,
  QuantizedNote,
  ScoreChord,
  ScoreDiagnostic,
  ScoreDraft,
  ScoreEvent,
  ScorePitch,
  ScorePart,
  ScoreTuplet
} from "./types";

const PIANO_PROGRAM_MIN = 0;
const PIANO_PROGRAM_MAX = 7;
const GRAND_STAFF_RANGE_SPLIT_MIDI = 60;

type PartSource = {
  id: string;
  name: string;
  tracks: ParsedTrack[];
  notes: MidiNote[];
  program: number;
  isDrum: boolean;
};

type CreatedPart = {
  part: ScorePart;
  tuplets: ScoreTuplet[];
};

export function createScoreDraft({ song, shortestNote = "1/16" }: CreateScoreDraftInput): ScoreDraft {
  const diagnostics: ScoreDiagnostic[] = [];
  const measures = createMeasureMap(song.meta, diagnostics);
  const gridTicks = shortestNoteTicks(song.meta.ppq, shortestNote);
  const createdParts = createPartSources(song).map((source) => createPart(song, source, measures, gridTicks, diagnostics));
  const parts = createdParts.map((createdPart) => createdPart.part);
  const tuplets = createdParts.flatMap((createdPart) => createdPart.tuplets);

  if (!song.meta.keySignatures.length) {
    diagnostics.push({
      severity: "info",
      code: "MISSING_KEY_SIGNATURE",
      message: "MIDI 未提供调号，当前五线谱按 C 调基础拼写显示。"
    });
  }

  for (const part of parts) {
    for (const staff of part.staves) {
      staff.events = createStaffEvents(
        part.id,
        staff.index,
        staff.events as ScoreChord[],
        measures,
        song.meta.ppq,
        tuplets
      );
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
    tuplets,
    diagnostics
  };
}

function createPart(
  song: ParsedSong,
  source: PartSource,
  measures: ScoreDraft["measures"],
  gridTicks: number,
  diagnostics: ScoreDiagnostic[]
): CreatedPart {
  const sourceNotes = source.notes;
  const averagePitch =
    sourceNotes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, sourceNotes.length);
  const useGrandStaff = shouldUseGrandStaff(source);
  const quantized = quantizeNotesWithContext({
    notes: sourceNotes,
    measures,
    ppq: song.meta.ppq,
    regularGridTicks: gridTicks,
    diagnostics,
    trackIndex: source.tracks[0]?.index ?? 0,
    partId: source.id
  });
  const baseQuantizedNotes = quantized.notes;
  const quantizedNotes = useGrandStaff ? assignPianoStaves(baseQuantizedNotes, measures) : baseQuantizedNotes;
  const pitchSpellings = createPitchSpellings(quantizedNotes, measures, song.meta.keySignatures);
  const chordEvents = createChordEvents(source.id, quantizedNotes, song.meta.ppq, pitchSpellings);
  const firstTrackIndex = source.tracks[0]?.index ?? 0;
  const trebleChords = chordEvents.filter((chord) => chord.staffIndex === 0);
  const bassChords = chordEvents.filter((chord) => chord.staffIndex === 1);
  const trebleVoiceCount = assignVoices(trebleChords, measures, song.meta.ppq, firstTrackIndex, diagnostics);
  const bassVoiceCount = assignVoices(bassChords, measures, song.meta.ppq, firstTrackIndex, diagnostics);
  const tuplets = materializeTuplets(quantized.tuplets, chordEvents, song.meta.ppq);
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
    part: {
      id: source.id,
      name: source.name,
      sourceTrackIndex: firstTrackIndex,
      sourceTrackIndexes: source.tracks.map((track) => track.index),
      program: source.program,
      isDrum: source.isDrum,
      staves
    },
    tuplets
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
    (minPitch < GRAND_STAFF_RANGE_SPLIT_MIDI && maxPitch >= GRAND_STAFF_RANGE_SPLIT_MIDI && maxPitch - minPitch >= 18)
  );
}

function createChordEvents(
  partId: string,
  notes: QuantizedNote[],
  ppq: number,
  pitchSpellings: Map<string, ScorePitch>
): ScoreChord[] {
  const grouped = new Map<string, QuantizedNote[]>();

  for (const note of notes) {
    const key = `${note.staffIndex}:${note.quantizedStartTicks}:${note.quantizedEndTicks}:${note.tupletId ?? "regular"}`;
    grouped.set(key, [...(grouped.get(key) ?? []), note]);
  }

  return [...grouped.entries()]
    .map(([key, group], index) => {
      const [staffIndexText, tickText, endTickText] = key.split(":");
      const startTicks = Number(tickText);
      const staffIndex = Number(staffIndexText);
      const endTicks = Number(endTickText);
      const timeModification = group.find((note) => note.timeModification)?.timeModification;
      const tupletId = group.find((note) => note.tupletId)?.tupletId;
      const duration = durationNameFromTicks(endTicks - startTicks, ppq, timeModification);
      const baseId = `${partId}-chord-${index}-${startTicks}`;

      return {
        id: baseId,
        baseId,
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
        tupletId,
        timeModification,
        notes: group
          .sort((a, b) => a.midi - b.midi)
          .map((note) => ({
            ...(pitchSpellings.get(note.id) ?? {
              midi: note.midi,
              step: "C" as const,
              alter: 0 as const,
              octave: Math.floor(note.midi / 12) - 1
            }),
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

function createStaffEvents(
  partId: string,
  staffIndex: number,
  chords: ScoreChord[],
  measures: ScoreDraft["measures"],
  ppq: number,
  tuplets: ScoreTuplet[]
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
        .sort((a, b) => a.startTicks - b.startTicks);

      let cursor = measure.startTicks;
      for (const chord of measureChords) {
        const chordStart = Math.max(chord.startTicks, measure.startTicks);
        const chordEnd = Math.min(chord.endTicks, measure.endTicks);

        if (chordStart > cursor) {
          events.push(
            ...spellRestRangeIntoMeasure(partId, staffIndex, voiceIndex, measure, cursor, chordStart, ppq, tuplets)
          );
        }
        events.push(...spellChordIntoMeasure(chord, measure, ppq));
        cursor = Math.max(cursor, chordEnd);
      }

      if (cursor < measure.endTicks) {
        events.push(
          ...spellRestRangeIntoMeasure(partId, staffIndex, voiceIndex, measure, cursor, measure.endTicks, ppq, tuplets)
        );
      }
    }
  }

  return events;
}

function materializeTuplets(baseTuplets: ScoreTuplet[], chords: ScoreChord[], ppq: number): ScoreTuplet[] {
  const tuplets: ScoreTuplet[] = [];

  for (const baseTuplet of baseTuplets) {
    const tupletChords = chords.filter((chord) => chord.tupletId === baseTuplet.id);
    const groups = new Map<string, ScoreChord[]>();

    for (const chord of tupletChords) {
      const key = `${chord.staffIndex}:${chord.voiceIndex}`;
      groups.set(key, [...(groups.get(key) ?? []), chord]);
    }

    for (const [key, group] of groups.entries()) {
      const uniqueSlots = new Set(group.map((chord) => slotIndexForTuplet(chord.startTicks, baseTuplet)));
      const [staffIndexText, voiceIndexText] = key.split(":");

      if (
        uniqueSlots.size < 2 ||
        uniqueSlots.size > baseTuplet.actualNotes ||
        [...uniqueSlots].some((slot) => slot === null || !baseTuplet.slots.includes(slot))
      ) {
        for (const chord of group) {
          chord.tupletId = undefined;
          chord.timeModification = undefined;
          const duration = durationNameFromTicks(chord.endTicks - chord.startTicks, ppq);
          chord.durationName = duration.name;
          chord.dots = duration.dots;
        }
        continue;
      }

      const id = `${baseTuplet.baseId}-s${staffIndexText}-v${voiceIndexText}`;
      for (const chord of group) {
        chord.tupletId = id;
      }
      tuplets.push({
        ...baseTuplet,
        id,
        staffIndex: Number(staffIndexText),
        voiceIndex: Number(voiceIndexText)
      });
    }
  }

  return tuplets;
}

function slotIndexForTuplet(startTicks: number, tuplet: ScoreTuplet): number | null {
  const offset = startTicks - tuplet.startTicks;
  if (offset < 0 || offset % tuplet.slotTicks !== 0) {
    return null;
  }

  const slot = offset / tuplet.slotTicks;
  return slot >= 0 && slot < tuplet.actualNotes ? slot : null;
}

function spellRestRangeIntoMeasure(
  partId: string,
  staffIndex: number,
  voiceIndex: number,
  measure: ScoreDraft["measures"][number],
  startTicks: number,
  endTicks: number,
  ppq: number,
  tuplets: ScoreTuplet[]
): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  const relevantTuplets = tuplets
    .filter(
      (tuplet) =>
        tuplet.partId === partId &&
        tuplet.staffIndex === staffIndex &&
        tuplet.voiceIndex === voiceIndex &&
        tuplet.measureIndex === measure.index &&
        tuplet.startTicks < endTicks &&
        tuplet.endTicks > startTicks
    )
    .sort((a, b) => a.startTicks - b.startTicks);
  let cursor = startTicks;

  for (const tuplet of relevantTuplets) {
    const tupletStart = Math.max(tuplet.startTicks, startTicks);
    const tupletEnd = Math.min(tuplet.endTicks, endTicks);

    if (tupletStart > cursor) {
      events.push(...spellRestIntoMeasure(partId, staffIndex, voiceIndex, measure, cursor, tupletStart, ppq));
    }

    if (tupletEnd > tupletStart) {
      events.push(
        ...spellRestIntoMeasure(partId, staffIndex, voiceIndex, measure, tupletStart, tupletEnd, ppq, {
          tupletId: tuplet.id,
          timeModification: {
            actualNotes: tuplet.actualNotes,
            normalNotes: tuplet.normalNotes
          }
        })
      );
    }

    cursor = Math.max(cursor, tupletEnd);
  }

  if (cursor < endTicks) {
    events.push(...spellRestIntoMeasure(partId, staffIndex, voiceIndex, measure, cursor, endTicks, ppq));
  }

  return events;
}
