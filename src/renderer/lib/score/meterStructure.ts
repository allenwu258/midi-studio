import type { ScoreMeasure } from "./types";

export type MeterBoundaryRole = "measure" | "strong" | "beat" | "subbeat";

export type MeterBoundary = {
  ticks: number;
  role: MeterBoundaryRole;
};

export type MeterGroup = {
  startTicks: number;
  endTicks: number;
  role: "strong" | "beat" | "subbeat";
};

export type MeterStructure = {
  measure: ScoreMeasure;
  beatTicks: number;
  groups: MeterGroup[];
  boundaries: MeterBoundary[];
};

export function createMeterStructure(measure: ScoreMeasure, ppq: number): MeterStructure {
  const beatTicks = Math.max(1, Math.round((ppq * 4) / measure.denominator));
  const groups = createBeatGroups(measure, beatTicks);
  const boundaryMap = new Map<number, MeterBoundaryRole>();

  addBoundary(boundaryMap, measure.startTicks, "measure");
  addBoundary(boundaryMap, measure.endTicks, "measure");

  for (const group of groups.slice(1)) {
    addBoundary(boundaryMap, group.startTicks, group.role);
  }

  return {
    measure,
    beatTicks,
    groups,
    boundaries: [...boundaryMap.entries()]
      .map(([ticks, role]) => ({ ticks, role }))
      .sort((a, b) => a.ticks - b.ticks)
  };
}

export function boundariesForNoteSpelling(structure: MeterStructure): number[] {
  return structure.boundaries
    .filter((boundary) => boundary.role === "measure" || boundary.role === "strong")
    .map((boundary) => boundary.ticks);
}

export function boundariesForRestSpelling(structure: MeterStructure): number[] {
  return structure.boundaries
    .filter((boundary) => boundary.role === "measure" || boundary.role === "strong" || boundary.role === "beat")
    .map((boundary) => boundary.ticks);
}

export function nextBeatBoundary(ticks: number, structure: MeterStructure): number | null {
  const next = structure.boundaries.find(
    (boundary) =>
      boundary.ticks > ticks &&
      boundary.ticks < structure.measure.endTicks &&
      (boundary.role === "strong" || boundary.role === "beat")
  );
  return next?.ticks ?? null;
}

export function isOnBeatBoundary(ticks: number, structure: MeterStructure): boolean {
  return structure.boundaries.some(
    (boundary) =>
      boundary.ticks === ticks &&
      (boundary.role === "measure" || boundary.role === "strong" || boundary.role === "beat")
  );
}

function createBeatGroups(measure: ScoreMeasure, beatTicks: number): MeterGroup[] {
  if (measure.numerator === 4 && measure.denominator === 4) {
    return simpleBeatGroups(measure, beatTicks, [0, 2]);
  }

  if (measure.numerator === 3 && measure.denominator === 4) {
    return simpleBeatGroups(measure, beatTicks, [0]);
  }

  if (measure.numerator === 6 && measure.denominator === 8) {
    return compoundBeatGroups(measure, beatTicks, 3);
  }

  if (measure.denominator === 8 && measure.numerator % 3 === 0 && measure.numerator > 3) {
    return compoundBeatGroups(measure, beatTicks, 3);
  }

  return simpleBeatGroups(measure, beatTicks, [0]);
}

function simpleBeatGroups(measure: ScoreMeasure, beatTicks: number, strongBeatIndexes: number[]): MeterGroup[] {
  const groups: MeterGroup[] = [];
  const beatCount = Math.max(1, Math.round((measure.endTicks - measure.startTicks) / beatTicks));

  for (let beatIndex = 0; beatIndex < beatCount; beatIndex += 1) {
    groups.push({
      startTicks: measure.startTicks + beatIndex * beatTicks,
      endTicks: Math.min(measure.endTicks, measure.startTicks + (beatIndex + 1) * beatTicks),
      role: strongBeatIndexes.includes(beatIndex) ? "strong" : "beat"
    });
  }

  return groups;
}

function compoundBeatGroups(measure: ScoreMeasure, beatTicks: number, beatsPerGroup: number): MeterGroup[] {
  const groups: MeterGroup[] = [];
  const groupTicks = beatTicks * beatsPerGroup;

  for (let startTicks = measure.startTicks; startTicks < measure.endTicks; startTicks += groupTicks) {
    groups.push({
      startTicks,
      endTicks: Math.min(measure.endTicks, startTicks + groupTicks),
      role: "strong"
    });
  }

  return groups;
}

function addBoundary(boundaryMap: Map<number, MeterBoundaryRole>, ticks: number, role: MeterBoundaryRole) {
  const existing = boundaryMap.get(ticks);
  if (!existing || boundaryPriority(role) > boundaryPriority(existing)) {
    boundaryMap.set(ticks, role);
  }
}

function boundaryPriority(role: MeterBoundaryRole): number {
  switch (role) {
    case "measure":
      return 4;
    case "strong":
      return 3;
    case "beat":
      return 2;
    case "subbeat":
    default:
      return 1;
  }
}
