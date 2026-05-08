import { durationNameFromTicks } from "./durations";
import {
  boundariesForNoteSpelling,
  boundariesForRestSpelling,
  createMeterStructure,
  isOnBeatBoundary,
  nextBeatBoundary
} from "./meterStructure";
import type { ScoreChord, ScoreMeasure, ScoreRest, ScoreTimeModification } from "./types";

type RhythmSegment = {
  startTicks: number;
  endTicks: number;
};

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
      tieStop: chord.tieStop || segment.startTicks > chord.startTicks,
      tieStart: chord.tieStart || segment.endTicks < chord.endTicks
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

export function splitRangeForRhythmSpelling(
  startTicks: number,
  endTicks: number,
  measure: ScoreMeasure,
  ppq: number,
  kind: "chord" | "rest"
): RhythmSegment[] {
  return splitRangeAtReadableBoundaries(startTicks, endTicks, measure, ppq, kind);
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

  if (kind === "rest" && startTicks === measure.startTicks && endTicks === measure.endTicks) {
    return [{ startTicks, endTicks }];
  }

  const meter = createMeterStructure(measure, ppq);
  const boundaries = kind === "rest"
    ? boundariesForRestSpelling(meter)
    : boundariesForNoteSpelling(meter);
  const segments: RhythmSegment[] = [];
  let cursor = startTicks;

  while (cursor < endTicks) {
    const syncopationBoundary =
      kind === "chord" && !isOnBeatBoundary(cursor, meter)
        ? nextBeatBoundary(cursor, meter)
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
