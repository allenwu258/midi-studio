import type { ScoreChord, ScoreDraft, ScoreEvent, ScoreMeasure, ScoreNote, ScorePart, ScoreStaff } from "../score";

export type StemDirection = "up" | "down";

export type RenderBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RenderScore = {
  score: ScoreDraft;
  width: number;
  height: number;
  systems: RenderSystem[];
  elementBoxes: Map<string, RenderBox>;
};

export type RenderSystem = {
  index: number;
  y: number;
  height: number;
  endX: number;
  measures: RenderMeasure[];
  parts: RenderPart[];
};

export type RenderMeasure = {
  measure: ScoreMeasure;
  x: number;
  width: number;
  offset: number;
};

export type RenderPart = {
  part: ScorePart;
  name: string;
  top: number;
  bottom: number;
  staves: RenderStaff[];
};

export type RenderStaff = {
  partId: string;
  staff: ScoreStaff;
  staffTop: number;
  events: RenderEvent[];
  beams: RenderBeamGroup[];
  tuplets: RenderTuplet[];
};

export type RenderEvent = {
  event: ScoreEvent;
  measure: RenderMeasure;
  x: number;
  box: RenderBox;
  stemDirection?: StemDirection;
  beamed: boolean;
  notes: RenderNote[];
  restY: number;
};

export type RenderNote = {
  note: ScoreNote;
  y: number;
  accidentalX: number;
  ledgerLines: number[];
};

export type RenderBeamGroup = {
  id: string;
  eventIds: string[];
  direction: StemDirection;
  points: RenderBeamPoint[];
  maxBeamCount: number;
};

export type RenderBeamPoint = {
  event: ScoreChord;
  eventId: string;
  stemX: number;
  baseY: number;
  beamY: number;
};

export type RenderTuplet = {
  id: string;
  eventIds: string[];
  label: string;
  x1: number;
  x2: number;
  y: number;
  bracketY: number;
  direction: StemDirection;
};

export type RenderLayoutOptions = {
  width: number;
  pagePadding: number;
  scoreLeft: number;
  scoreRight: number;
  measuresPerSystem: number;
  minMeasureWidth: number;
  clefTimeWidth: number;
  measureEndPadding: number;
  lineGap: number;
  staffHeight: number;
  staffGap: number;
  partGap: number;
  systemTopPadding: number;
  systemBottomPadding: number;
  systemGap: number;
  stemLength: number;
};

export const DEFAULT_RENDER_LAYOUT_OPTIONS: RenderLayoutOptions = {
  width: 1120,
  pagePadding: 28,
  scoreLeft: 82,
  scoreRight: 28,
  measuresPerSystem: 4,
  minMeasureWidth: 148,
  clefTimeWidth: 78,
  measureEndPadding: 24,
  lineGap: 10,
  staffHeight: 40,
  staffGap: 76,
  partGap: 42,
  systemTopPadding: 26,
  systemBottomPadding: 24,
  systemGap: 34,
  stemLength: 42
};
