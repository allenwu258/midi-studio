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

type QuantState = {
  cost: number;
  previousIndex: number;
};

type MeasureQuantContext = {
  measure: ScoreMeasure;
  ppq: number;
  allowsTripletGrid: boolean;
  tripletGridTicks: number;
  tuplets: ScoreTuplet[];
};

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
  const startTicksByNoteId = quantizeStarts(sortedNotes, contexts, ppq, regularGridTicks);

  return {
    notes: sortedNotes.map((note) => {
    const context = findContextForTicks(contexts, note.startTicks);
    const quantizedStartTicks = startTicksByNoteId.get(note.id) ?? quantizeTicks(note.startTicks, regularGridTicks);
    let quantizedEndTicks = quantizeEndTicks(note, quantizedStartTicks, context, regularGridTicks);
    const tuplet = findTupletForRange(contexts, quantizedStartTicks, quantizedEndTicks);

    if (quantizedEndTicks <= quantizedStartTicks) {
      quantizedEndTicks = quantizedStartTicks + Math.max(1, Math.min(regularGridTicks, context.tripletGridTicks));
    }

    return {
      ...note,
      quantizedStartTicks,
      quantizedEndTicks,
      staffIndex: 0,
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

function quantizeStarts(
  notes: MidiNote[],
  contexts: MeasureQuantContext[],
  ppq: number,
  regularGridTicks: number
): Map<string, number> {
  const candidateSets = notes.map((note) => {
    const context = findContextForTicks(contexts, note.startTicks);
    return startCandidates(note.startTicks, context, ppq, regularGridTicks);
  });
  const states: QuantState[][] = [];

  for (let noteIndex = 0; noteIndex < notes.length; noteIndex += 1) {
    states[noteIndex] = [];

    for (let candidateIndex = 0; candidateIndex < candidateSets[noteIndex].length; candidateIndex += 1) {
      const candidate = candidateSets[noteIndex][candidateIndex];

      if (noteIndex === 0) {
        states[noteIndex][candidateIndex] = {
          cost: candidate.localPenalty,
          previousIndex: -1
        };
        continue;
      }

      let bestCost = Number.POSITIVE_INFINITY;
      let bestPreviousIndex = 0;

      for (let previousIndex = 0; previousIndex < candidateSets[noteIndex - 1].length; previousIndex += 1) {
        const previous = candidateSets[noteIndex - 1][previousIndex];
        if (candidate.ticks < previous.ticks) {
          continue;
        }

        const transition = transitionPenalty(previous, candidate, notes[noteIndex - 1], notes[noteIndex]);
        const cost = states[noteIndex - 1][previousIndex].cost + candidate.localPenalty + transition;
        if (cost < bestCost) {
          bestCost = cost;
          bestPreviousIndex = previousIndex;
        }
      }

      states[noteIndex][candidateIndex] = {
        cost: bestCost,
        previousIndex: bestPreviousIndex
      };
    }
  }

  const result = new Map<string, number>();
  let bestIndex = indexOfLowestCost(states[states.length - 1]);

  for (let noteIndex = notes.length - 1; noteIndex >= 0; noteIndex -= 1) {
    const candidate = candidateSets[noteIndex][bestIndex];
    result.set(notes[noteIndex].id, candidate.ticks);
    bestIndex = states[noteIndex][bestIndex].previousIndex;
  }

  return result;
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

function transitionPenalty(
  previous: QuantCandidate,
  current: QuantCandidate,
  previousNote: MidiNote,
  currentNote: MidiNote
): number {
  const sameOriginalOnset = Math.abs(previousNote.startTicks - currentNote.startTicks) <= 8;
  const sameQuantizedOnset = previous.ticks === current.ticks;
  const mergePenalty = sameOriginalOnset === sameQuantizedOnset ? 0 : 12;
  const gridSwitchPenalty = previous.grid === current.grid ? 0 : 3;
  return mergePenalty + gridSwitchPenalty;
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

function isCloserToGrid(ticks: number, originTicks: number, candidateGridTicks: number, regularGridTicks: number): boolean {
  return distanceToGrid(ticks, originTicks, candidateGridTicks) < distanceToGrid(ticks, originTicks, regularGridTicks);
}

function clampToMeasure(ticks: number, measure: ScoreMeasure): number {
  return Math.max(measure.startTicks, Math.min(measure.endTicks - 1, ticks));
}

function indexOfLowestCost(states: QuantState[]): number {
  let result = 0;
  for (let index = 1; index < states.length; index += 1) {
    if (states[index].cost < states[result].cost) {
      result = index;
    }
  }
  return result;
}
