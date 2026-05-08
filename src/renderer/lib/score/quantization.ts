import type { MidiNote } from "../midi";
import { durationNameFromTicks, quantizeTicks } from "./durations";
import { createMeterStructure } from "./meterStructure";
import type { QuantizedNote, ScoreDiagnostic, ScoreMeasure, ScoreTuplet } from "./types";

type QuantizeNotesInput = {
  notes: MidiNote[];
  measures: ScoreMeasure[];
  ppq: number;
  regularGridTicks: number;
  diagnostics: ScoreDiagnostic[];
  trackIndex: number;
  partId: string;
};

type QuantCandidate = {
  ticks: number;
  grid: "regular" | "triplet";
  metricalLevel: number;
  localPenalty: number;
};

type MeasureNotePlan = {
  note: MidiNote;
  startTicks: number;
  endTicks: number;
  voiceIndex: number;
  tuplet?: ScoreTuplet;
  cost: number;
};

type MeasureVoiceState = {
  endTicks: number;
  averagePitch: number | null;
  lastStartTicks: number;
};

type MeasureSearchState = {
  cost: number;
  voices: MeasureVoiceState[];
  plans: MeasureNotePlan[];
};

type MeasureQuantContext = {
  measure: ScoreMeasure;
  ppq: number;
  allowsTripletGrid: boolean;
  tripletGridTicks: number;
  tuplets: ScoreTuplet[];
};

const MEASURE_VOICE_LIMIT = 2;
const MAX_MEASURE_SEARCH_STATES = 96;
const MAX_NOTE_CANDIDATES = 10;
const MEASURE_SEARCH_NOTE_LIMIT = 36;

export type QuantizeNotesResult = {
  notes: QuantizedNote[];
  tuplets: ScoreTuplet[];
};

export function quantizeNotesWithContext({
  notes,
  measures,
  ppq,
  regularGridTicks,
  diagnostics,
  trackIndex,
  partId
}: QuantizeNotesInput): QuantizeNotesResult {
  const contexts = measures.map((measure) =>
    createMeasureQuantContext(measure, notes, ppq, regularGridTicks, trackIndex, partId)
  );
  reportTripletDiagnostics(contexts, diagnostics, trackIndex);
  const sortedNotes = [...notes].sort((a, b) => a.startTicks - b.startTicks || a.midi - b.midi);
  const measurePlans = createMeasureQuantPlans(sortedNotes, contexts, ppq, regularGridTicks, diagnostics, trackIndex);

  return {
    notes: sortedNotes.map((note) => {
      const context = findContextForTicks(contexts, note.startTicks);
      const plan = measurePlans.get(note.id);
      const quantizedStartTicks = plan?.startTicks ?? quantizeTicks(note.startTicks, regularGridTicks);
      let quantizedEndTicks = plan?.endTicks ?? quantizeEndTicks(note, quantizedStartTicks, context, regularGridTicks);
      const tuplet = plan?.tuplet ?? findTupletForRange(contexts, quantizedStartTicks, quantizedEndTicks);

      if (quantizedEndTicks <= quantizedStartTicks) {
        quantizedEndTicks = quantizedStartTicks + Math.max(1, Math.min(regularGridTicks, context.tripletGridTicks));
      }

      return {
        ...note,
        quantizedStartTicks,
        quantizedEndTicks,
        staffIndex: 0,
        quantizedVoiceIndex: plan?.voiceIndex,
        tupletId: tuplet?.id,
        timeModification: tuplet
          ? {
              actualNotes: tuplet.actualNotes,
              normalNotes: tuplet.normalNotes
            }
          : undefined
      };
    }),
    tuplets: contexts.flatMap((context) => context.tuplets)
  };
}

function createMeasureQuantPlans(
  notes: MidiNote[],
  contexts: MeasureQuantContext[],
  ppq: number,
  regularGridTicks: number,
  diagnostics: ScoreDiagnostic[],
  trackIndex: number
): Map<string, MeasureNotePlan> {
  const result = new Map<string, MeasureNotePlan>();

  for (const context of contexts) {
    const measureNotes = notes.filter(
      (note) => note.startTicks >= context.measure.startTicks && note.startTicks < context.measure.endTicks
    );
    const useGreedyFallback = measureNotes.length > MEASURE_SEARCH_NOTE_LIMIT;
    const plans = useGreedyFallback
      ? greedyMeasurePlans(measureNotes, context, ppq, regularGridTicks)
      : searchMeasurePlans(measureNotes, context, ppq, regularGridTicks);

    for (const plan of plans) {
      result.set(plan.note.id, plan);
    }

    if (useGreedyFallback) {
      diagnostics.push({
        severity: "info",
        code: "QUANTIZATION_WINDOW_FALLBACK",
        message: "小节音符密度较高，Quantization 2.0 已切换为贪心候选选择以保持导入速度。",
        trackIndex,
        tick: context.measure.startTicks
      });
    }
  }

  return result;
}

function searchMeasurePlans(
  notes: MidiNote[],
  context: MeasureQuantContext,
  ppq: number,
  regularGridTicks: number
): MeasureNotePlan[] {
  if (!notes.length) {
    return [];
  }

  const sortedNotes = [...notes].sort((a, b) => a.startTicks - b.startTicks || b.endTicks - a.endTicks || b.midi - a.midi);
  let states: MeasureSearchState[] = [
    {
      cost: 0,
      voices: Array.from({ length: MEASURE_VOICE_LIMIT }, () => ({
        endTicks: context.measure.startTicks,
        averagePitch: null,
        lastStartTicks: context.measure.startTicks
      })),
      plans: []
    }
  ];

  for (const note of sortedNotes) {
    const candidates = createMeasureNoteCandidates(note, context, ppq, regularGridTicks);
    const nextStates: MeasureSearchState[] = [];

    for (const state of states) {
      for (const candidate of candidates) {
        const stepCost = scoreMeasurePlan(candidate, state, context, ppq);
        const voices = state.voices.map((voice) => ({ ...voice }));
        voices[candidate.voiceIndex] = advanceMeasureVoice(voices[candidate.voiceIndex], candidate);
        nextStates.push({
          cost: state.cost + candidate.cost + stepCost,
          voices,
          plans: [...state.plans, candidate]
        });
      }
    }

    states = pruneMeasureSearchStates(nextStates);
  }

  return states.sort((a, b) => a.cost - b.cost)[0]?.plans ?? [];
}

function greedyMeasurePlans(
  notes: MidiNote[],
  context: MeasureQuantContext,
  ppq: number,
  regularGridTicks: number
): MeasureNotePlan[] {
  const plans: MeasureNotePlan[] = [];
  const state: MeasureSearchState = {
    cost: 0,
    voices: Array.from({ length: MEASURE_VOICE_LIMIT }, () => ({
      endTicks: context.measure.startTicks,
      averagePitch: null,
      lastStartTicks: context.measure.startTicks
    })),
    plans
  };
  const sortedNotes = [...notes].sort((a, b) => a.startTicks - b.startTicks || b.endTicks - a.endTicks || b.midi - a.midi);

  for (const note of sortedNotes) {
    const best = createMeasureNoteCandidates(note, context, ppq, regularGridTicks)
      .map((candidate) => ({
        candidate,
        cost: candidate.cost + scoreMeasurePlan(candidate, state, context, ppq)
      }))
      .sort((a, b) => a.cost - b.cost || a.candidate.voiceIndex - b.candidate.voiceIndex)[0]?.candidate;

    if (!best) {
      continue;
    }

    plans.push(best);
    state.voices[best.voiceIndex] = advanceMeasureVoice(state.voices[best.voiceIndex], best);
  }

  return plans;
}

function createMeasureNoteCandidates(
  note: MidiNote,
  context: MeasureQuantContext,
  ppq: number,
  regularGridTicks: number
): MeasureNotePlan[] {
  const candidates: MeasureNotePlan[] = [];
  const startOptions = startCandidates(note.startTicks, context, ppq, regularGridTicks);

  for (const start of startOptions) {
    const endOptions = endCandidates(note, start.ticks, context, regularGridTicks)
      .sort((a, b) => a.penalty - b.penalty || a.ticks - b.ticks)
      .slice(0, 4);

    for (const end of endOptions) {
      const endTicks = Math.max(end.ticks, start.ticks + 1);
      const tuplet = findTupletForRange([context], start.ticks, endTicks);
      const duration = durationNameFromTicks(endTicks - start.ticks, ppq, tuplet
        ? {
            actualNotes: tuplet.actualNotes,
            normalNotes: tuplet.normalNotes
          }
        : undefined);
      const durationCost = duration.dots * 4 + (duration.name === "32nd" ? 6 : 0);
      const tieCost = readableBoundaryCount(start.ticks, endTicks, context) * 7;
      const tupletCost = tuplet ? -8 : start.grid === "triplet" ? 14 : 0;

      for (let voiceIndex = 0; voiceIndex < MEASURE_VOICE_LIMIT; voiceIndex += 1) {
        candidates.push({
          note,
          startTicks: start.ticks,
          endTicks,
          voiceIndex,
          tuplet,
          cost: start.localPenalty + end.penalty + durationCost + tieCost + tupletCost + voiceIndex * 1.2
        });
      }
    }
  }

  return candidates
    .sort((a, b) => a.cost - b.cost || a.startTicks - b.startTicks || a.endTicks - b.endTicks || a.voiceIndex - b.voiceIndex)
    .slice(0, MAX_NOTE_CANDIDATES);
}

function scoreMeasurePlan(
  candidate: MeasureNotePlan,
  state: MeasureSearchState,
  context: MeasureQuantContext,
  ppq: number
): number {
  const voice = state.voices[candidate.voiceIndex];
  const overlapTicks = Math.max(0, voice.endTicks - candidate.startTicks);
  const overlapCost = overlapTicks > 0 ? 80_000 + overlapTicks * 0.9 : 0;
  const restCost = voice.averagePitch === null || overlapTicks > 0
    ? 0
    : Math.min(18, (candidate.startTicks - voice.endTicks) / Math.max(1, ppq / 2));
  const continuityCost = voice.averagePitch === null ? 0 : Math.abs(candidate.note.midi - voice.averagePitch) * 0.42;
  const sameStartCost = sameStartVoiceCost(candidate, state.plans);
  const laneCost = candidate.voiceIndex === 0
    ? Math.max(0, 58 - candidate.note.midi) * 0.35
    : Math.max(0, candidate.note.midi - 62) * 0.35;
  const measureEndBonus = candidate.endTicks === context.measure.endTicks ? -3 : 0;

  return overlapCost + restCost + continuityCost + sameStartCost + laneCost + measureEndBonus;
}

function sameStartVoiceCost(candidate: MeasureNotePlan, previousPlans: MeasureNotePlan[]): number {
  let cost = 0;

  for (const previous of previousPlans) {
    if (previous.startTicks !== candidate.startTicks || previous.endTicks === candidate.endTicks) {
      continue;
    }

    if (previous.voiceIndex === candidate.voiceIndex) {
      cost += 140;
      continue;
    }

    const candidateUpper = candidate.note.midi > previous.note.midi;
    const candidateShorter = candidate.endTicks - candidate.startTicks < previous.endTicks - previous.startTicks;
    const preferredVoiceIndex = candidateUpper || candidateShorter ? 0 : 1;
    cost += candidate.voiceIndex === preferredVoiceIndex ? -24 : 28;
  }

  return cost;
}

function advanceMeasureVoice(voice: MeasureVoiceState, candidate: MeasureNotePlan): MeasureVoiceState {
  return {
    endTicks: Math.max(voice.endTicks, candidate.endTicks),
    averagePitch: candidate.note.midi,
    lastStartTicks: candidate.startTicks
  };
}

function pruneMeasureSearchStates(states: MeasureSearchState[]): MeasureSearchState[] {
  const bestBySignature = new Map<string, MeasureSearchState>();

  for (const state of states) {
    const signature = state.voices
      .map((voice) => `${voice.endTicks}:${voice.lastStartTicks}:${Math.round(voice.averagePitch ?? -1)}`)
      .join("|");
    const existing = bestBySignature.get(signature);
    if (!existing || state.cost < existing.cost) {
      bestBySignature.set(signature, state);
    }
  }

  return [...bestBySignature.values()]
    .sort((a, b) => a.cost - b.cost)
    .slice(0, MAX_MEASURE_SEARCH_STATES);
}

function readableBoundaryCount(startTicks: number, endTicks: number, context: MeasureQuantContext): number {
  const meter = createMeterStructure(context.measure, context.ppq);
  return meter.boundaries.filter(
    (boundary) => boundary.ticks > startTicks && boundary.ticks < endTicks && boundary.role !== "subbeat"
  ).length;
}

function startCandidates(
  originalTicks: number,
  context: MeasureQuantContext,
  ppq: number,
  regularGridTicks: number
): QuantCandidate[] {
  const candidates = new Map<number, QuantCandidate>();

  addCandidate(candidates, originalTicks, context, regularGridTicks, "regular", ppq);
  addNeighborCandidates(candidates, originalTicks, context, regularGridTicks, "regular", ppq);

  if (context.allowsTripletGrid) {
    addCandidate(candidates, originalTicks, context, context.tripletGridTicks, "triplet", ppq);
    addNeighborCandidates(candidates, originalTicks, context, context.tripletGridTicks, "triplet", ppq);
  }

  return [...candidates.values()].sort((a, b) => a.localPenalty - b.localPenalty || a.ticks - b.ticks).slice(0, 6);
}

function addCandidate(
  candidates: Map<number, QuantCandidate>,
  originalTicks: number,
  context: MeasureQuantContext,
  gridTicks: number,
  grid: QuantCandidate["grid"],
  ppq: number
) {
  const ticks = clampToMeasure(quantizeTicks(originalTicks - context.measure.startTicks, gridTicks) + context.measure.startTicks, context.measure);
  const existing = candidates.get(ticks);
  const candidate = createCandidate(ticks, originalTicks, context, grid, ppq);
  if (!existing || candidate.localPenalty < existing.localPenalty) {
    candidates.set(ticks, candidate);
  }
}

function addNeighborCandidates(
  candidates: Map<number, QuantCandidate>,
  originalTicks: number,
  context: MeasureQuantContext,
  gridTicks: number,
  grid: QuantCandidate["grid"],
  ppq: number
) {
  const rounded = quantizeTicks(originalTicks - context.measure.startTicks, gridTicks) + context.measure.startTicks;
  for (const ticks of [rounded - gridTicks, rounded + gridTicks]) {
    if (ticks >= context.measure.startTicks && ticks < context.measure.endTicks) {
      const candidate = createCandidate(ticks, originalTicks, context, grid, ppq);
      const existing = candidates.get(ticks);
      if (!existing || candidate.localPenalty < existing.localPenalty) {
        candidates.set(ticks, candidate);
      }
    }
  }
}

function createCandidate(
  ticks: number,
  originalTicks: number,
  context: MeasureQuantContext,
  grid: QuantCandidate["grid"],
  ppq: number
): QuantCandidate {
  const distance = Math.abs(originalTicks - ticks);
  const metricalLevel = metricalLevelForTicks(ticks, context.measure, ppq);
  const gridPenalty = grid === "triplet" ? 0.5 : 0;
  return {
    ticks,
    grid,
    metricalLevel,
    localPenalty: distance * (1 + Math.max(0, 3 - metricalLevel) * 0.08) + gridPenalty
  };
}

function quantizeEndTicks(
  note: MidiNote,
  quantizedStartTicks: number,
  context: MeasureQuantContext,
  regularGridTicks: number
): number {
  return endCandidates(note, quantizedStartTicks, context, regularGridTicks)
    .sort((a, b) => a.penalty - b.penalty || a.ticks - b.ticks)[0].ticks;
}

function createMeasureQuantContext(
  measure: ScoreMeasure,
  notes: MidiNote[],
  ppq: number,
  regularGridTicks: number,
  trackIndex: number,
  partId: string
): MeasureQuantContext {
  const tripletGridTicks = Math.max(1, Math.round(ppq / 3));
  const measureNotes = notes.filter((note) => note.startTicks >= measure.startTicks && note.startTicks < measure.endTicks);
  const tripletLikeOnsets = new Set<number>();

  for (const note of measureNotes) {
    const regularDistance = distanceToGrid(note.startTicks, measure.startTicks, regularGridTicks);
    const tripletDistance = distanceToGrid(note.startTicks, measure.startTicks, tripletGridTicks);
    if (tripletDistance + regularGridTicks * 0.12 < regularDistance && tripletDistance <= tripletGridTicks * 0.2) {
      tripletLikeOnsets.add(Math.round((note.startTicks - measure.startTicks) / tripletGridTicks));
    }
  }

  const tuplets = createTripletTuplets(measure, measureNotes, ppq, regularGridTicks, tripletGridTicks, trackIndex, partId);

  return {
    measure,
    ppq,
    allowsTripletGrid: tripletLikeOnsets.size >= 3 || tuplets.length > 0,
    tripletGridTicks,
    tuplets
  };
}

function createTripletTuplets(
  measure: ScoreMeasure,
  notes: MidiNote[],
  ppq: number,
  regularGridTicks: number,
  tripletGridTicks: number,
  trackIndex: number,
  partId: string
): ScoreTuplet[] {
  const tuplets: ScoreTuplet[] = [];
  const meter = createMeterStructure(measure, ppq);

  for (const group of meter.groups) {
    const groupTicks = group.endTicks - group.startTicks;
    const isSimpleTripletGroup = groupTicks === Math.max(1, Math.round((ppq * 4) / measure.denominator));
    const tupletGridTicks = isSimpleTripletGroup ? tripletGridTicks : Math.max(1, Math.round(groupTicks / 3));
    const matchingSlots = new Set<number>();
    for (const note of notes) {
      if (note.startTicks < group.startTicks || note.startTicks >= group.endTicks) {
        continue;
      }

      const regularDistance = distanceToGrid(note.startTicks, group.startTicks, regularGridTicks);
      const tripletDistance = distanceToGrid(note.startTicks, group.startTicks, tupletGridTicks);
      const slot = Math.round((note.startTicks - group.startTicks) / tupletGridTicks);
      if (
        slot >= 0 &&
        slot < 3 &&
        tripletDistance + regularGridTicks * 0.12 < regularDistance &&
        tripletDistance <= tripletGridTicks * 0.24
      ) {
        matchingSlots.add(slot);
      }
    }

    if (matchingSlots.size >= 2) {
      tuplets.push({
        id: `${partId}-tuplet-${measure.index}-${group.startTicks}`,
        baseId: `${partId}-tuplet-${measure.index}-${group.startTicks}`,
        partId,
        sourceTrackIndex: trackIndex,
        measureIndex: measure.index,
        startTicks: group.startTicks,
        endTicks: group.endTicks,
        slotTicks: tupletGridTicks,
        slots: [...matchingSlots].sort((a, b) => a - b),
        actualNotes: 3,
        normalNotes: 2
      });
    }
  }

  return tuplets;
}

function endCandidates(
  note: MidiNote,
  quantizedStartTicks: number,
  context: MeasureQuantContext,
  regularGridTicks: number
): Array<{ ticks: number; penalty: number }> {
  const candidates = new Map<number, number>();
  const grids = context.allowsTripletGrid
    ? [regularGridTicks, context.tripletGridTicks]
    : [regularGridTicks];

  for (const gridTicks of grids) {
    addEndCandidate(candidates, note, quantizedStartTicks, context, gridTicks);
    const rounded = quantizeTicks(note.endTicks - context.measure.startTicks, gridTicks) + context.measure.startTicks;
    for (const ticks of [rounded - gridTicks, rounded + gridTicks]) {
      addEndCandidate(candidates, note, quantizedStartTicks, context, gridTicks, ticks);
    }
  }

  for (const boundary of endBoundaryCandidates(note, context)) {
    addEndCandidate(candidates, note, quantizedStartTicks, context, regularGridTicks, boundary);
  }

  if (!candidates.size) {
    const fallback = quantizedStartTicks + Math.max(1, regularGridTicks);
    candidates.set(fallback, Number.POSITIVE_INFINITY);
  }

  return [...candidates.entries()].map(([ticks, penalty]) => ({ ticks, penalty }));
}

function addEndCandidate(
  candidates: Map<number, number>,
  note: MidiNote,
  quantizedStartTicks: number,
  context: MeasureQuantContext,
  gridTicks: number,
  explicitTicks?: number
) {
  const ticks = explicitTicks ?? quantizeTicks(note.endTicks - context.measure.startTicks, gridTicks) + context.measure.startTicks;
  if (ticks <= quantizedStartTicks) {
    return;
  }

  const penalty = endCandidatePenalty(note, quantizedStartTicks, ticks, context);
  const existing = candidates.get(ticks);
  if (existing === undefined || penalty < existing) {
    candidates.set(ticks, penalty);
  }
}

function endBoundaryCandidates(note: MidiNote, context: MeasureQuantContext): number[] {
  return [
    context.measure.startTicks,
    context.measure.endTicks,
    ...context.tuplets.flatMap((tuplet) => [tuplet.startTicks, tuplet.endTicks])
  ].filter((ticks) => Math.abs(note.endTicks - ticks) <= Math.max(12, context.tripletGridTicks * 0.3));
}

function endCandidatePenalty(
  note: MidiNote,
  quantizedStartTicks: number,
  candidateEndTicks: number,
  context: MeasureQuantContext
): number {
  const durationTicks = candidateEndTicks - quantizedStartTicks;
  const distancePenalty = Math.abs(note.endTicks - candidateEndTicks);
  const duration = durationNameFromTicks(durationTicks, context.ppq);
  const dotPenalty = duration.dots * 4;
  const shortFragmentPenalty = duration.name === "32nd" ? 8 : 0;
  const boundaryBonus = candidateEndTicks === context.measure.endTicks ? -6 : 0;
  const tupletBonus = context.tuplets.some((tuplet) => candidateEndTicks === tuplet.endTicks || candidateEndTicks === tuplet.startTicks) ? -4 : 0;

  return distancePenalty + dotPenalty + shortFragmentPenalty + boundaryBonus + tupletBonus;
}

function reportTripletDiagnostics(
  contexts: MeasureQuantContext[],
  diagnostics: ScoreDiagnostic[],
  trackIndex: number
) {
  const firstTripletContext = contexts.find((context) => context.allowsTripletGrid);
  if (!firstTripletContext) {
    return;
  }

  diagnostics.push({
    severity: "info",
    code: "TUPLET_GRID_DETECTED",
    message: "检测到疑似三连音网格，已在量化阶段优先吸附到三连音候选。",
    trackIndex,
    tick: firstTripletContext.measure.startTicks
  });
}

function findContextForTicks(contexts: MeasureQuantContext[], ticks: number): MeasureQuantContext {
  return (
    contexts.find((context) => ticks >= context.measure.startTicks && ticks < context.measure.endTicks) ??
    contexts[contexts.length - 1]
  );
}

function findTupletForRange(contexts: MeasureQuantContext[], startTicks: number, endTicks: number): ScoreTuplet | undefined {
  const context = findContextForTicks(contexts, startTicks);
  return context.tuplets.find(
    (tuplet) =>
      startTicks >= tuplet.startTicks &&
      endTicks <= tuplet.endTicks &&
      isTupletSlotStart(startTicks, tuplet)
  );
}

function isTupletSlotStart(startTicks: number, tuplet: ScoreTuplet): boolean {
  const offset = startTicks - tuplet.startTicks;
  if (offset < 0 || offset % tuplet.slotTicks !== 0) {
    return false;
  }

  const slot = offset / tuplet.slotTicks;
  return slot >= 0 && slot < tuplet.actualNotes && tuplet.slots.includes(slot);
}

function metricalLevelForTicks(ticks: number, measure: ScoreMeasure, ppq: number): number {
  const localTicks = ticks - measure.startTicks;
  if (localTicks === 0) {
    return 4;
  }
  if (localTicks % ppq === 0) {
    return 3;
  }
  if (localTicks % Math.max(1, ppq / 2) === 0) {
    return 2;
  }
  return 1;
}

function distanceToGrid(ticks: number, originTicks: number, gridTicks: number): number {
  const local = ticks - originTicks;
  const rounded = quantizeTicks(local, gridTicks);
  return Math.abs(local - rounded);
}

function clampToMeasure(ticks: number, measure: ScoreMeasure): number {
  return Math.max(measure.startTicks, Math.min(measure.endTicks - 1, ticks));
}
