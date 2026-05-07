import type { QuantizedNote, ScoreMeasure } from "./types";

const TREBLE_STAFF = 0;
const BASS_STAFF = 1;
const DEFAULT_SPLIT_MIDI = 60;
const COMFORT_LOW_TREBLE = 55;
const COMFORT_HIGH_BASS = 65;
const MAX_COMFORTABLE_HAND_SPAN = 16;
const TREBLE_LEDGER_LOW = 60;
const BASS_LEDGER_HIGH = 59;

type PianoSplitCandidate = {
  splitIndex: number;
  staffByNoteId: Map<string, number>;
  localCost: number;
  startTicks: number;
  trebleAverage: number | null;
  bassAverage: number | null;
  trebleEndTicks: number | null;
  bassEndTicks: number | null;
};

type PianoSplitState = {
  cost: number;
  previousIndex: number;
};

export function assignPianoStaves(
  notes: QuantizedNote[],
  measures: ScoreMeasure[] = [],
  splitMidi = DEFAULT_SPLIT_MIDI
): QuantizedNote[] {
  if (notes.length === 0) {
    return notes;
  }

  const groups = groupNotesByOnset(notes, measures);
  const candidates = groups.map((group) => createCandidates(group, splitMidi));
  const bestPath = chooseBestCandidatePath(candidates);
  const staffByNoteId = new Map<string, number>();

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const candidate = candidates[groupIndex][bestPath[groupIndex]];
    for (const [noteId, staffIndex] of candidate.staffByNoteId.entries()) {
      staffByNoteId.set(noteId, staffIndex);
    }
  }

  return notes.map((note) => ({
    ...note,
    staffIndex: staffByNoteId.get(note.id) ?? (note.midi < splitMidi ? BASS_STAFF : TREBLE_STAFF)
  }));
}

function groupNotesByOnset(notes: QuantizedNote[], measures: ScoreMeasure[]): QuantizedNote[][] {
  const groups = new Map<number, QuantizedNote[]>();

  for (const note of notes) {
    groups.set(note.quantizedStartTicks, [...(groups.get(note.quantizedStartTicks) ?? []), note]);
  }

  const onsetGroups = [...groups.values()]
    .map((group) => group.sort((a, b) => a.midi - b.midi || a.quantizedEndTicks - b.quantizedEndTicks))
    .sort((a, b) => a[0].quantizedStartTicks - b[0].quantizedStartTicks);

  if (!measures.length) {
    return onsetGroups;
  }

  return onsetGroups.sort((a, b) =>
    measureIndexForTicks(a[0].quantizedStartTicks, measures) - measureIndexForTicks(b[0].quantizedStartTicks, measures) ||
    a[0].quantizedStartTicks - b[0].quantizedStartTicks
  );
}

function createCandidates(group: QuantizedNote[], splitMidi: number): PianoSplitCandidate[] {
  const candidates: PianoSplitCandidate[] = [];

  for (let splitIndex = 0; splitIndex <= group.length; splitIndex += 1) {
    const bassNotes = group.slice(0, splitIndex);
    const trebleNotes = group.slice(splitIndex);
    const staffByNoteId = new Map<string, number>();

    for (const note of bassNotes) {
      staffByNoteId.set(note.id, BASS_STAFF);
    }
    for (const note of trebleNotes) {
      staffByNoteId.set(note.id, TREBLE_STAFF);
    }

    candidates.push({
      splitIndex,
      staffByNoteId,
      startTicks: group[0]?.quantizedStartTicks ?? 0,
      localCost:
        handPitchCost(trebleNotes, TREBLE_STAFF, splitMidi) +
        handPitchCost(bassNotes, BASS_STAFF, splitMidi) +
        handSpanCost(trebleNotes) +
        handSpanCost(bassNotes) +
        ledgerLineCost(trebleNotes, TREBLE_STAFF) +
        ledgerLineCost(bassNotes, BASS_STAFF) +
        crossStaffCost(bassNotes, trebleNotes) +
        emptyHandCost(group, bassNotes, trebleNotes),
      trebleAverage: averagePitch(trebleNotes),
      bassAverage: averagePitch(bassNotes),
      trebleEndTicks: endTicks(trebleNotes),
      bassEndTicks: endTicks(bassNotes)
    });
  }

  return candidates.sort((a, b) => a.localCost - b.localCost || a.splitIndex - b.splitIndex);
}

function chooseBestCandidatePath(candidates: PianoSplitCandidate[][]): number[] {
  const states: PianoSplitState[][] = [];

  for (let groupIndex = 0; groupIndex < candidates.length; groupIndex += 1) {
    states[groupIndex] = [];

    for (let candidateIndex = 0; candidateIndex < candidates[groupIndex].length; candidateIndex += 1) {
      const candidate = candidates[groupIndex][candidateIndex];

      if (groupIndex === 0) {
        states[groupIndex][candidateIndex] = {
          cost: candidate.localCost,
          previousIndex: -1
        };
        continue;
      }

      let bestCost = Number.POSITIVE_INFINITY;
      let bestPreviousIndex = 0;

      for (let previousIndex = 0; previousIndex < candidates[groupIndex - 1].length; previousIndex += 1) {
        const previous = candidates[groupIndex - 1][previousIndex];
        const transition = transitionCost(previous, candidate);
        const cost = states[groupIndex - 1][previousIndex].cost + candidate.localCost + transition;

        if (cost < bestCost) {
          bestCost = cost;
          bestPreviousIndex = previousIndex;
        }
      }

      states[groupIndex][candidateIndex] = {
        cost: bestCost,
        previousIndex: bestPreviousIndex
      };
    }
  }

  const path: number[] = [];
  let bestIndex = indexOfLowestCost(states[states.length - 1]);

  for (let groupIndex = candidates.length - 1; groupIndex >= 0; groupIndex -= 1) {
    path[groupIndex] = bestIndex;
    bestIndex = states[groupIndex][bestIndex].previousIndex;
  }

  return path;
}

function handPitchCost(notes: QuantizedNote[], staffIndex: number, splitMidi: number): number {
  return notes.reduce((cost, note) => {
    if (staffIndex === TREBLE_STAFF) {
      const belowComfort = Math.max(0, COMFORT_LOW_TREBLE - note.midi);
      const belowSplit = Math.max(0, splitMidi - note.midi);
      return cost + belowComfort * 2.4 + belowSplit * 0.8;
    }

    const aboveComfort = Math.max(0, note.midi - COMFORT_HIGH_BASS);
    const aboveSplit = Math.max(0, note.midi - splitMidi);
    return cost + aboveComfort * 2.4 + aboveSplit * 0.8;
  }, 0);
}

function handSpanCost(notes: QuantizedNote[]): number {
  if (notes.length < 2) {
    return 0;
  }

  const minPitch = Math.min(...notes.map((note) => note.midi));
  const maxPitch = Math.max(...notes.map((note) => note.midi));
  return Math.max(0, maxPitch - minPitch - MAX_COMFORTABLE_HAND_SPAN) * 3;
}

function emptyHandCost(group: QuantizedNote[], bassNotes: QuantizedNote[], trebleNotes: QuantizedNote[]): number {
  if (group.length === 1) {
    return 0;
  }

  if (bassNotes.length === 0 || trebleNotes.length === 0) {
    return Math.min(8, group.length * 1.5);
  }

  return 0;
}

function transitionCost(previous: PianoSplitCandidate, current: PianoSplitCandidate): number {
  const splitJump = Math.abs(current.splitIndex - previous.splitIndex) * 2.25;
  const trebleJump = averageJump(previous.trebleAverage, current.trebleAverage) * 0.18;
  const bassJump = averageJump(previous.bassAverage, current.bassAverage) * 0.18;
  const sustainContinuity = sustainContinuityCost(previous, current);
  const handDropout =
    (previous.trebleAverage === null && current.trebleAverage !== null) ||
    (previous.trebleAverage !== null && current.trebleAverage === null) ||
    (previous.bassAverage === null && current.bassAverage !== null) ||
    (previous.bassAverage !== null && current.bassAverage === null)
      ? 3
      : 0;

  return splitJump + trebleJump + bassJump + sustainContinuity + handDropout;
}

function ledgerLineCost(notes: QuantizedNote[], staffIndex: number): number {
  return notes.reduce((cost, note) => {
    if (staffIndex === TREBLE_STAFF) {
      return cost + Math.max(0, TREBLE_LEDGER_LOW - note.midi) * 1.8;
    }

    return cost + Math.max(0, note.midi - BASS_LEDGER_HIGH) * 1.8;
  }, 0);
}

function crossStaffCost(bassNotes: QuantizedNote[], trebleNotes: QuantizedNote[]): number {
  if (!bassNotes.length || !trebleNotes.length) {
    return 0;
  }

  const bassHigh = Math.max(...bassNotes.map((note) => note.midi));
  const trebleLow = Math.min(...trebleNotes.map((note) => note.midi));
  return bassHigh > trebleLow ? (bassHigh - trebleLow + 1) * 14 : 0;
}

function sustainContinuityCost(previous: PianoSplitCandidate, current: PianoSplitCandidate): number {
  const trebleOverlap =
    previous.trebleEndTicks !== null &&
    current.trebleAverage !== null &&
    previous.trebleEndTicks > current.startTicks;
  const bassOverlap =
    previous.bassEndTicks !== null &&
    current.bassAverage !== null &&
    previous.bassEndTicks > current.startTicks;
  const trebleCost = trebleOverlap && current.trebleAverage !== null && previous.bassAverage !== null && current.trebleAverage < previous.bassAverage
    ? 12
    : 0;
  const bassCost = bassOverlap && current.bassAverage !== null && previous.trebleAverage !== null && current.bassAverage > previous.trebleAverage
    ? 12
    : 0;

  return trebleCost + bassCost;
}

function endTicks(notes: QuantizedNote[]): number | null {
  return notes.length ? Math.max(...notes.map((note) => note.quantizedEndTicks)) : null;
}

function measureIndexForTicks(ticks: number, measures: ScoreMeasure[]): number {
  return measures.find((measure) => ticks >= measure.startTicks && ticks < measure.endTicks)?.index ?? measures.length;
}

function averagePitch(notes: QuantizedNote[]): number | null {
  if (!notes.length) {
    return null;
  }
  return notes.reduce((sum, note) => sum + note.midi, 0) / notes.length;
}

function averageJump(previous: number | null, current: number | null): number {
  if (previous === null || current === null) {
    return 0;
  }
  return Math.abs(current - previous);
}

function indexOfLowestCost(states: PianoSplitState[]): number {
  let result = 0;
  for (let index = 1; index < states.length; index += 1) {
    if (states[index].cost < states[result].cost) {
      result = index;
    }
  }
  return result;
}
