import type { ScoreChord, ScoreDraft, ScoreEvent, ScoreMeasure } from "../score";
import type { RenderLayoutOptions, RenderMeasure, RenderMeasureSpacing, RenderTimeSlice } from "./types";
import { beamCount } from "./beams";

type SliceProfile = {
  ticks: number;
  minLeft: number;
  minRight: number;
  rhythmicWeight: number;
};

const BASE_SLICE_GAP = 8;
const MIN_RHYTHMIC_GAP = 5;

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
  const spacingPlans = measures.map((measure, offset) => createMeasureSpacing(score, measure, offset, options));
  const weights = measures.map((measure, offset) => measureWeight(score, measure, offset));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const minWidths = spacingPlans.map((spacing) => Math.max(options.minMeasureWidth, spacing.minWidth));
  const minTotal = minWidths.reduce((sum, width) => sum + width, 0);
  const extraWidth = Math.max(0, systemWidth(options) - minTotal);
  let x = options.scoreLeft;

  return measures.map((measure, offset) => {
    const width = minWidths[offset] + (extraWidth * weights[offset]) / totalWeight;
    const spacing = scaleMeasureSpacing(spacingPlans[offset], width, options.measureEndPadding);
    const layout = { measure, x, width, offset, spacing };
    x += width;
    return layout;
  });
}

export function xForEvent(event: ScoreEvent, measureLayout: RenderMeasure, options: RenderLayoutOptions): number {
  const measure = measureLayout.measure;
  const slice = measureLayout.spacing.slices.find((item) => item.ticks === event.startTicks);

  if (slice) {
    return measureLayout.x + measureLayout.spacing.leading + slice.x;
  }

  const measureTicks = Math.max(1, measure.endTicks - measure.startTicks);
  const localRatio = (event.startTicks - measure.startTicks) / measureTicks;
  const leading = measureLayout.offset === 0 ? options.clefTimeWidth : 20;
  const drawableWidth = Math.max(44, measureLayout.width - leading - options.measureEndPadding);
  return measureLayout.x + leading + localRatio * drawableWidth;
}

function createMeasureSpacing(
  score: ScoreDraft,
  measure: ScoreMeasure,
  offset: number,
  options: RenderLayoutOptions
): RenderMeasureSpacing {
  const leading = offset === 0 ? options.clefTimeWidth : 20;
  const profiles = createSliceProfiles(score, measure);
  const slices = createMinimumSlices(profiles, measure, score.ppq);
  const minDrawableWidth = slices.length
    ? Math.max(44, slices[slices.length - 1].x + slices[slices.length - 1].minRight)
    : 44;

  return {
    leading,
    drawableWidth: minDrawableWidth,
    minWidth: leading + minDrawableWidth + options.measureEndPadding,
    slices
  };
}

function scaleMeasureSpacing(
  spacing: RenderMeasureSpacing,
  measureWidth: number,
  endPadding: number
): RenderMeasureSpacing {
  const drawableWidth = Math.max(spacing.drawableWidth, measureWidth - spacing.leading - endPadding);
  const extra = Math.max(0, drawableWidth - spacing.drawableWidth);
  const totalStretch = spacing.slices.reduce((sum, slice, index) => (
    index === 0 ? sum : sum + slice.stretchWeight
  ), 0) || 1;
  let accumulatedExtra = 0;
  const scaledSlices = spacing.slices.map((slice, index) => {
    if (index > 0) {
      accumulatedExtra += (extra * slice.stretchWeight) / totalStretch;
    }

    return {
      ...slice,
      x: slice.x + accumulatedExtra
    };
  });

  return {
    ...spacing,
    drawableWidth,
    slices: scaledSlices
  };
}

function createSliceProfiles(score: ScoreDraft, measure: ScoreMeasure): SliceProfile[] {
  const profiles = new Map<number, SliceProfile>();
  const events = score.parts.flatMap((part) =>
    part.staves.flatMap((staff) =>
      staff.events.filter((event) => event.measureIndex === measure.index && event.startTicks >= measure.startTicks)
    )
  );

  profiles.set(measure.startTicks, {
    ticks: measure.startTicks,
    minLeft: 0,
    minRight: 0,
    rhythmicWeight: 1
  });

  for (const event of events) {
    const existing = profiles.get(event.startTicks) ?? {
      ticks: event.startTicks,
      minLeft: 0,
      minRight: 0,
      rhythmicWeight: 1
    };
    const profile = eventGlyphProfile(event);

    profiles.set(event.startTicks, {
      ticks: event.startTicks,
      minLeft: Math.max(existing.minLeft, profile.minLeft),
      minRight: Math.max(existing.minRight, profile.minRight),
      rhythmicWeight: Math.max(existing.rhythmicWeight, profile.rhythmicWeight)
    });
  }

  return [...profiles.values()].sort((a, b) => a.ticks - b.ticks);
}

function createMinimumSlices(profiles: SliceProfile[], measure: ScoreMeasure, ppq: number): RenderTimeSlice[] {
  if (!profiles.length) {
    return [];
  }

  const slices: RenderTimeSlice[] = [];
  let previous = profiles[0];
  let x = previous.minLeft;
  slices.push({
    ticks: previous.ticks,
    x,
    minLeft: previous.minLeft,
    minRight: previous.minRight,
    stretchWeight: 0
  });

  for (const profile of profiles.slice(1)) {
    const tickDistance = Math.max(1, profile.ticks - previous.ticks);
    const stretchWeight = Math.sqrt(tickDistance / Math.max(1, ppq));
    const rhythmicGap = MIN_RHYTHMIC_GAP + stretchWeight * 11;
    const minGap = previous.minRight + profile.minLeft + BASE_SLICE_GAP + rhythmicGap;
    x += minGap * Math.max(0.85, Math.min(1.45, profile.rhythmicWeight));
    slices.push({
      ticks: profile.ticks,
      x,
      minLeft: profile.minLeft,
      minRight: profile.minRight,
      stretchWeight
    });
    previous = profile;
  }

  const measureTicks = Math.max(1, measure.endTicks - measure.startTicks);
  const finalTickDistance = Math.max(1, measure.endTicks - previous.ticks);
  if (previous.ticks < measure.endTicks && finalTickDistance < measureTicks) {
    x += MIN_RHYTHMIC_GAP + Math.sqrt(finalTickDistance / Math.max(1, ppq)) * 8;
  }

  return slices;
}

function eventGlyphProfile(event: ScoreEvent): Omit<SliceProfile, "ticks"> {
  if (event.kind === "rest") {
    return {
      minLeft: 9,
      minRight: 14 + event.dots * 7,
      rhythmicWeight: 0.9
    };
  }

  const accidentalCount = event.notes.filter((note) => note.alter !== 0).length;
  const closeIntervals = countCloseChordIntervals(event);
  const dotWidth = event.dots * 7;
  const tieWidth = event.tieStart ? 12 : 0;
  const beamWeight = beamCount(event.durationName) > 0 ? 1.18 : 1;

  return {
    minLeft: 14 + accidentalCount * 9,
    minRight: 18 + dotWidth + tieWidth + closeIntervals * 5,
    rhythmicWeight: beamWeight
  };
}

function countCloseChordIntervals(event: ScoreChord): number {
  const sorted = [...event.notes].sort((a, b) => a.midi - b.midi);
  let count = 0;

  for (let index = 1; index < sorted.length; index += 1) {
    const distance = Math.abs(sorted[index].midi - sorted[index - 1].midi);
    if (distance <= 2) {
      count += 1;
    }
  }

  return count;
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
