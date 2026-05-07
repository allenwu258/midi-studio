import type { ScoreDots, ScoreDurationName, ScoreTimeModification } from "./types";

const DURATION_ORDER: Array<{ name: ScoreDurationName; quarterUnits: number }> = [
  { name: "whole", quarterUnits: 4 },
  { name: "half", quarterUnits: 2 },
  { name: "quarter", quarterUnits: 1 },
  { name: "eighth", quarterUnits: 0.5 },
  { name: "16th", quarterUnits: 0.25 },
  { name: "32nd", quarterUnits: 0.125 }
];

export function durationNameFromTicks(
  durationTicks: number,
  ppq: number,
  timeModification?: ScoreTimeModification
): { name: ScoreDurationName; dots: ScoreDots } {
  const normalizedTicks = timeModification
    ? durationTicks * (timeModification.actualNotes / timeModification.normalNotes)
    : durationTicks;
  const quarterUnits = Math.max(0.125, normalizedTicks / ppq);
  let best = DURATION_ORDER[DURATION_ORDER.length - 1];
  let bestDots: ScoreDots = 0;
  let bestError = Number.POSITIVE_INFINITY;

  for (const duration of DURATION_ORDER) {
    const plainError = Math.abs(quarterUnits - duration.quarterUnits);
    if (plainError < bestError) {
      best = duration;
      bestDots = 0;
      bestError = plainError;
    }

    const dottedError = Math.abs(quarterUnits - duration.quarterUnits * 1.5);
    if (dottedError < bestError) {
      best = duration;
      bestDots = 1;
      bestError = dottedError;
    }

    const doubleDottedError = Math.abs(quarterUnits - duration.quarterUnits * 1.75);
    if (doubleDottedError < bestError) {
      best = duration;
      bestDots = 2;
      bestError = doubleDottedError;
    }
  }

  return { name: best.name, dots: bestDots };
}

export function shortestNoteTicks(ppq: number, shortestNote: "1/8" | "1/16" | "1/32" = "1/16"): number {
  switch (shortestNote) {
    case "1/8":
      return Math.max(1, Math.round(ppq / 2));
    case "1/32":
      return Math.max(1, Math.round(ppq / 8));
    case "1/16":
    default:
      return Math.max(1, Math.round(ppq / 4));
  }
}

export function quantizeTicks(ticks: number, gridTicks: number): number {
  return Math.max(0, Math.round(ticks / gridTicks) * gridTicks);
}
