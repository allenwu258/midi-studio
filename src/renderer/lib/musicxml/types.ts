import type { ParsedSong } from "../midi";
import type { ScoreDraft, ScoreDurationName, ScoreTimeModification } from "../score";

export type MusicXmlImportDiagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  partId?: string;
  measureIndex?: number;
  tick?: number;
};

export type MusicXmlClefSign = "G" | "F" | "C" | "percussion" | "unknown";

export type MusicXmlMeasureAttributes = {
  divisions: number;
  timeSignature: { numerator: number; denominator: number };
  keySignature: { key: string; scale: string };
  staves: number;
  clefs: Array<{ staffIndex: number; sign: MusicXmlClefSign; line: number | null }>;
};

export type MusicXmlScoreNote = {
  sourceNoteId: string;
  midi: number;
  step: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  alter: -1 | 0 | 1;
  octave: number;
  velocity: number;
};

export type MusicXmlScoreEventBase = {
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
  dots: 0 | 1 | 2;
  timeModification?: ScoreTimeModification;
};

export type MusicXmlScoreChord = MusicXmlScoreEventBase & {
  kind: "chord";
  notes: MusicXmlScoreNote[];
  sourceNoteIds: string[];
  tieStart: boolean;
  tieStop: boolean;
};

export type MusicXmlScoreRest = MusicXmlScoreEventBase & {
  kind: "rest";
};

export type MusicXmlScoreEvent = MusicXmlScoreChord | MusicXmlScoreRest;

export type MusicXmlScoreMeasure = {
  id: string;
  index: number;
  startTicks: number;
  endTicks: number;
  attributes: MusicXmlMeasureAttributes;
};

export type MusicXmlScorePart = {
  id: string;
  name: string;
  sourceTrackIndex: number;
  program: number;
  isDrum: boolean;
  staves: number;
  clefs: Array<{ staffIndex: number; sign: MusicXmlClefSign; line: number | null }>;
  events: MusicXmlScoreEvent[];
};

export type MusicXmlScoreSource = {
  id: string;
  title: string;
  ppq: number;
  durationMs: number;
  durationTicks: number;
  measures: MusicXmlScoreMeasure[];
  parts: MusicXmlScorePart[];
};

export type MusicXmlImportResult = {
  song: ParsedSong;
  midiBytes: ArrayBuffer;
  score: ScoreDraft;
  sourceScore: MusicXmlScoreSource;
  diagnostics: MusicXmlImportDiagnostic[];
  sourceFormat: "xml" | "mxl";
};
