import type { MidiNote, ParsedSong } from "../midi";

export type Clef = "treble" | "bass" | "percussion";

export type ScoreDiagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  trackIndex?: number;
  tick?: number;
};

export type ScoreMeasure = {
  id: string;
  index: number;
  startTicks: number;
  endTicks: number;
  numerator: number;
  denominator: number;
};

export type ScorePitch = {
  midi: number;
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  alter: -1 | 0 | 1;
  octave: number;
};

export type ScoreNote = ScorePitch & {
  sourceNoteId: string;
  velocity: number;
};

export type ScoreDurationName = "whole" | "half" | "quarter" | "eighth" | "16th" | "32nd";
export type ScoreDots = 0 | 1 | 2;

export type ScoreEventBase = {
  id: string;
  baseId: string;
  partId: string;
  staffIndex: number;
  voiceIndex: number;
  measureIndex: number;
  startTicks: number;
  endTicks: number;
  startMs: number;
  endMs: number;
  durationName: ScoreDurationName;
  dots: ScoreDots;
  tupletId?: string;
  timeModification?: ScoreTimeModification;
};

export type ScoreChord = ScoreEventBase & {
  kind: "chord";
  notes: ScoreNote[];
  sourceNoteIds: string[];
  tieStart: boolean;
  tieStop: boolean;
};

export type ScoreRest = ScoreEventBase & {
  kind: "rest";
};

export type ScoreEvent = ScoreChord | ScoreRest;

export type ScoreStaff = {
  index: number;
  clef: Clef;
  voiceCount: number;
  events: ScoreEvent[];
};

export type ScorePart = {
  id: string;
  name: string;
  sourceTrackIndex: number;
  sourceTrackIndexes: number[];
  program: number;
  isDrum: boolean;
  staves: ScoreStaff[];
};

export type ScoreTimeModification = {
  actualNotes: number;
  normalNotes: number;
};

export type ScoreTuplet = {
  id: string;
  baseId: string;
  partId: string;
  sourceTrackIndex: number;
  staffIndex?: number;
  voiceIndex?: number;
  measureIndex: number;
  startTicks: number;
  endTicks: number;
  slotTicks: number;
  slots: number[];
  actualNotes: number;
  normalNotes: number;
};

export type ScoreDraft = {
  id: string;
  title: string;
  ppq: number;
  durationMs: number;
  durationTicks: number;
  measures: ScoreMeasure[];
  parts: ScorePart[];
  tuplets: ScoreTuplet[];
  diagnostics: ScoreDiagnostic[];
};

export type QuantizedNote = MidiNote & {
  quantizedStartTicks: number;
  quantizedEndTicks: number;
  staffIndex: number;
  tupletId?: string;
  timeModification?: ScoreTimeModification;
};

export type CreateScoreDraftInput = {
  song: ParsedSong;
  shortestNote?: "1/8" | "1/16" | "1/32";
};
