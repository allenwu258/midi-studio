export type PlaybackMapEntry = {
  elementId: string;
  partId: string;
  measureIndex: number;
  staffIndex: number;
  voiceIndex: number;
  startMs: number;
  endMs: number;
  startTicks: number;
  endTicks: number;
  kind: "chord" | "rest";
};

export type ActiveScorePosition = {
  activeIds: Set<string>;
  pastMeasureIndex: number;
  activeMeasureIndex: number;
};
