import { durationNameFromTicks } from "./durations";
import type { ScoreChord, ScoreMeasure, ScoreRest, ScoreTimeModification } from "./types";

type RhythmSegment = {
  startTicks: number;
  endTicks: number;
};

const SIMPLE_BEAT_DENOMINATORS = new Set([2, 4, 8]);

export function spellChordIntoMeasure(
  chord: ScoreChord,
  measure: ScoreMeasure,
  ppq: number
): ScoreChord[] {
  const clippedStart = Math.max(chord.startTicks, measure.startTicks);
  const clippedEnd = Math.min(chord.endTicks, measure.endTicks);
  const segments = splitRangeAtReadableBoundaries(clippedStart, clippedEnd, measure, ppq, "chord");

  return segments.map((segment, index) => {
    const duration = durationNameFromTicks(segment.endTicks - segment.startTicks, ppq, chord.timeModification);
    const ratioStart = (segment.startTicks - chord.startTicks) / Math.max(1, chord.endTicks - chord.startTicks);
    const ratioEnd = (segment.endTicks - chord.startTicks) / Math.max(1, chord.endTicks - chord.startTicks);
    const msRange = chord.endMs - chord.startMs;

    return {
      ...chord,
      id: `${chord.baseId}-m${measure.index}-${segment.startTicks}-${index}`,
      measureIndex: measure.index,
      startTicks: segment.startTicks,
      endTicks: segment.endTicks,
      startMs: chord.startMs + msRange * ratioStart,
      endMs: chord.startMs + msRange * ratioEnd,
      durationName: duration.name,
      dots: duration.dots,
      tieStop: segment.startTicks > chord.startTicks,
      tieStart: segment.endTicks < chord.endTicks
    };
  });
}

export function spellRestIntoMeasure(
  partId: string,
  staffIndex: number,
  voiceIndex: number,
  measure: ScoreMeasure,
  startTicks: number,
  endTicks: number,
  ppq: number,
  tupletContext?: { tupletId: string; timeModification: ScoreTimeModification }
): ScoreRest[] {
  return splitRangeAtReadableBoundaries(startTicks, endTicks, measure, ppq, "rest").map((segment, index) => {
    const duration = durationNameFromTicks(segment.endTicks - segment.startTicks, ppq, tupletContext?.timeModification);
    const baseId = `${partId}-rest-${staffIndex}-${voiceIndex}-${measure.index}-${segment.startTicks}`;

    return {
      id: `${baseId}-${index}`,
      baseId,
      partId,
      staffIndex,
      voiceIndex,
      measureIndex: measure.index,
      kind: "rest",
      startTicks: segment.startTicks,
      endTicks: segment.endTicks,
      startMs: 0,
      endMs: 0,
      durationName: duration.name,
      dots: duration.dots,
      tupletId: tupletContext?.tupletId,
      timeModification: tupletContext?.timeModification
    };
  });
}

function splitRangeAtReadableBoundaries(
  startTicks: number,
  endTicks: number,
  measure: ScoreMeasure,
  ppq: number,
  kind: "chord" | "rest"
): RhythmSegment[] {
  if (endTicks <= startTicks) {
    return [];
  }

  const boundaries = rhythmBoundaries(measure, ppq, kind);
  const beatTicks = Math.max(1, Math.round((ppq * 4) / measure.denominator));
  const segments: RhythmSegment[] = [];
  let cursor = startTicks;

  while (cursor < endTicks) {
    const syncopationBoundary =
      kind === "chord" && !isOnBeat(cursor, measure.startTicks, beatTicks)
        ? nextBeatBoundary(cursor, measure, beatTicks)
        : null;
    const nextBoundary = [...boundaries, syncopationBoundary]
      .filter((boundary): boundary is number => boundary !== null && boundary > cursor && boundary < endTicks)
      .sort((a, b) => a - b)[0];
    const nextTicks = nextBoundary ?? endTicks;
    segments.push({ startTicks: cursor, endTicks: nextTicks });
    cursor = nextTicks;
  }

  return segments;
}

function rhythmBoundaries(measure: ScoreMeasure, ppq: number, kind: "chord" | "rest"): number[] {
  const measureTicks = measure.endTicks - measure.startTicks;
  const beatTicks = Math.max(1, Math.round((ppq * 4) / measure.denominator));
  const boundaries = new Set<number>();

  boundaries.add(measure.startTicks);
  boundaries.add(measure.endTicks);

  if (kind === "rest") {
    addBeatBoundaries(boundaries, measure, beatTicks);
    return [...boundaries].sort((a, b) => a - b);
  }

  addStrongBeatBoundaries(boundaries, measure, measureTicks, beatTicks);

  return [...boundaries].sort((a, b) => a - b);
}

function addBeatBoundaries(boundaries: Set<number>, measure: ScoreMeasure, beatTicks: number) {
  for (let tick = measure.startTicks + beatTicks; tick < measure.endTicks; tick += beatTicks) {
    boundaries.add(tick);
  }
}

function addStrongBeatBoundaries(
  boundaries: Set<number>,
  measure: ScoreMeasure,
  measureTicks: number,
  beatTicks: number
) {
  if (measure.denominator === 4 && measure.numerator === 4) {
    boundaries.add(measure.startTicks + measureTicks / 2);
    return;
  }

  if (measure.denominator === 8 && measure.numerator % 3 === 0 && measure.numerator > 3) {
    for (let tick = measure.startTicks + beatTicks * 3; tick < measure.endTicks; tick += beatTicks * 3) {
      boundaries.add(tick);
    }
    return;
  }

  if (SIMPLE_BEAT_DENOMINATORS.has(measure.denominator)) {
    const halfMeasure = measure.startTicks + measureTicks / 2;
    if (Number.isInteger(halfMeasure)) {
      boundaries.add(halfMeasure);
    }
  }
}

function isOnBeat(ticks: number, measureStartTicks: number, beatTicks: number): boolean {
  return (ticks - measureStartTicks) % beatTicks === 0;
}

function nextBeatBoundary(ticks: number, measure: ScoreMeasure, beatTicks: number): number | null {
  const beatOffset = Math.floor((ticks - measure.startTicks) / beatTicks) + 1;
  const boundary = measure.startTicks + beatOffset * beatTicks;
  return boundary < measure.endTicks ? boundary : null;
}
