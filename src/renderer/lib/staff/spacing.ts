import type { ScoreChord, ScoreDraft, ScoreEvent, ScoreMeasure } from "../score";
import type { RenderLayoutOptions, RenderMeasure } from "./types";
import { beamCount } from "./beams";

export function partHeight(staffCount: number, options: RenderLayoutOptions): number {
  return options.staffHeight + Math.max(0, staffCount - 1) * options.staffGap;
}

export function systemWidth(options: RenderLayoutOptions): number {
  return options.width - options.scoreLeft - options.scoreRight;
}

export function createSystemMeasureLayouts(
  score: ScoreDraft,
  measures: ScoreMeasure[],
  options: RenderLayoutOptions
): RenderMeasure[] {
  const weights = measures.map((measure, offset) => measureWeight(score, measure, offset));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const minTotal = measures.length * options.minMeasureWidth;
  const availableWidth = Math.max(minTotal, systemWidth(options));
  let x = options.scoreLeft;

  return measures.map((measure, offset) => {
    const width = Math.max(options.minMeasureWidth, (availableWidth * weights[offset]) / totalWeight);
    const layout = { measure, x, width, offset };
    x += width;
    return layout;
  });
}

export function xForEvent(event: ScoreEvent, measureLayout: RenderMeasure, options: RenderLayoutOptions): number {
  const measure = measureLayout.measure;
  const measureTicks = Math.max(1, measure.endTicks - measure.startTicks);
  const localRatio = (event.startTicks - measure.startTicks) / measureTicks;
  const leading = measureLayout.offset === 0 ? options.clefTimeWidth : 20;
  const drawableWidth = Math.max(44, measureLayout.width - leading - options.measureEndPadding);
  return measureLayout.x + leading + localRatio * drawableWidth;
}

function measureWeight(score: ScoreDraft, measure: ScoreMeasure, offset: number): number {
  const chords = score.parts.flatMap((part) =>
    part.staves.flatMap((staff) =>
      staff.events.filter((event): event is ScoreChord => event.kind === "chord" && event.measureIndex === measure.index)
    )
  );
  const shortNotes = chords.filter((event) => beamCount(event.durationName) > 0).length;
  const voiceLoad = new Set(chords.map((event) => `${event.partId}:${event.staffIndex}:${event.voiceIndex}`)).size;

  return 1.6 + chords.length * 0.2 + shortNotes * 0.24 + voiceLoad * 0.12 + (offset === 0 ? 0.55 : 0);
}
