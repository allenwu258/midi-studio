import type { ScoreChord, ScoreDiagnostic, ScoreMeasure } from "./types";

const DEFAULT_VOICE_LIMIT = 2;
const MAX_WINDOW_CHORDS = 12;
const MAX_SEARCH_STATES = 64;
const ILLEGAL_OVERLAP_PENALTY = 100_000;

type VoiceState = {
  endTicks: number;
  averagePitch: number | null;
  lastStartTicks: number;
};

type SearchState = {
  assignments: number[];
  voices: VoiceState[];
  cost: number;
  illegalOverlapTicks: number;
};

type AssignmentResult = {
  assignments: number[];
  cost: number;
  illegalOverlapTicks: number;
  finalVoices: VoiceState[];
};

export function assignVoices(
  chords: ScoreChord[],
  measures: ScoreMeasure[],
  ppq: number,
  trackIndex: number,
  diagnostics: ScoreDiagnostic[],
  voiceLimit = DEFAULT_VOICE_LIMIT
): number {
  const sortedChords = chords.sort((a, b) => a.startTicks - b.startTicks || averagePitch(b) - averagePitch(a));
  const voiceStates: VoiceState[] = Array.from({ length: voiceLimit }, () => emptyVoiceState());
  let usedVoiceCount = sortedChords.length ? 1 : 0;
  const reportedMeasures = new Set<number>();

  for (const measure of measures) {
    const measureChords = sortedChords.filter(
      (chord) => chord.startTicks >= measure.startTicks && chord.startTicks < measure.endTicks
    );

    expireVoiceStates(voiceStates, measure.startTicks);

    for (const windowChords of createMeasureWindows(measureChords)) {
      const result = searchWindowAssignments(windowChords, voiceStates, ppq, voiceLimit);

      for (const [index, chord] of windowChords.entries()) {
        const voiceIndex = result.assignments[index] ?? 0;
        chord.voiceIndex = voiceIndex;
        usedVoiceCount = Math.max(usedVoiceCount, voiceIndex + 1);
      }

      copyVoiceStates(voiceStates, result.finalVoices);

      if (result.illegalOverlapTicks > 0 && !reportedMeasures.has(measure.index)) {
        diagnostics.push({
          severity: "warning",
          code: "VOICE_WINDOW_UNRESOLVED",
          message: "检测到小节内复调超过当前窗口搜索能力，部分声部可能仍有重叠或休止符复杂度较高。",
          trackIndex,
          tick: measure.startTicks
        });
        reportedMeasures.add(measure.index);
      }
    }
  }

  return Math.max(1, usedVoiceCount);
}

function searchWindowAssignments(
  chords: ScoreChord[],
  incomingVoices: VoiceState[],
  ppq: number,
  voiceLimit: number
): AssignmentResult {
  if (!chords.length) {
    return {
      assignments: [],
      cost: 0,
      illegalOverlapTicks: 0,
      finalVoices: incomingVoices.map((voice) => ({ ...voice }))
    };
  }

  let states: SearchState[] = [
    {
      assignments: [],
      voices: incomingVoices.map((voice) => ({ ...voice })),
      cost: 0,
      illegalOverlapTicks: 0
    }
  ];

  for (const [chordIndex, chord] of chords.entries()) {
    const nextStates: SearchState[] = [];

    for (const state of states) {
      for (let voiceIndex = 0; voiceIndex < voiceLimit; voiceIndex += 1) {
        const step = scoreVoiceStep(chord, chordIndex, voiceIndex, chords, state, ppq);
        const voices = state.voices.map((voice) => ({ ...voice }));
        voices[voiceIndex] = advanceVoice(voices[voiceIndex], chord);
        nextStates.push({
          assignments: [...state.assignments, voiceIndex],
          voices,
          cost: state.cost + step.cost,
          illegalOverlapTicks: state.illegalOverlapTicks + step.illegalOverlapTicks
        });
      }
    }

    states = pruneSearchStates(nextStates);
  }

  const best = states.sort((a, b) => a.cost - b.cost || a.illegalOverlapTicks - b.illegalOverlapTicks)[0];
  return {
    assignments: best.assignments,
    cost: best.cost,
    illegalOverlapTicks: best.illegalOverlapTicks,
    finalVoices: best.voices
  };
}

function scoreVoiceStep(
  chord: ScoreChord,
  chordIndex: number,
  voiceIndex: number,
  chords: ScoreChord[],
  state: SearchState,
  ppq: number
): { cost: number; illegalOverlapTicks: number } {
  const voice = state.voices[voiceIndex];
  const chordAverage = averagePitch(chord);
  const overlapTicks = Math.max(0, voice.endTicks - chord.startTicks);
  const sameStartLayerCost = sameStartLayeringCost(chord, chordIndex, voiceIndex, chords, state.assignments);
  const overlapCost = overlapTicks > 0 ? ILLEGAL_OVERLAP_PENALTY + overlapTicks * 0.8 : 0;
  const tieCost = tieCountCost(chord, voice);
  const restCost = restComplexityCost(chord, voice, voiceIndex, ppq);
  const continuityCost = voice.averagePitch === null ? 0 : Math.abs(chordAverage - voice.averagePitch) * 0.55;
  const laneCost = voiceLaneCost(chordAverage, voiceIndex, hasAnyActiveVoice(chord, state.voices));
  const activationCost = voice.averagePitch === null ? voiceIndex * 3.5 : 0;
  const quantizationHintCost = chord.voiceIndex === voiceIndex ? -22 : 42;

  return {
    cost: overlapCost + sameStartLayerCost + tieCost + restCost + continuityCost + laneCost + activationCost + quantizationHintCost,
    illegalOverlapTicks: overlapTicks
  };
}

function sameStartLayeringCost(
  chord: ScoreChord,
  chordIndex: number,
  voiceIndex: number,
  chords: ScoreChord[],
  previousAssignments: number[]
): number {
  let cost = 0;

  for (let index = 0; index < chordIndex; index += 1) {
    const previous = chords[index];
    if (previous.startTicks !== chord.startTicks || previous.endTicks === chord.endTicks) {
      continue;
    }

    const previousVoiceIndex = previousAssignments[index];
    const previousAverage = averagePitch(previous);
    const chordAverage = averagePitch(chord);

    if (previousVoiceIndex === voiceIndex) {
      cost += 160;
      continue;
    }

    const chordIsUpper = chordAverage > previousAverage;
    const chordIsShorter = durationTicks(chord) < durationTicks(previous);
    const preferredVoiceIndex = chordIsUpper || chordIsShorter ? 0 : 1;
    cost += voiceIndex === preferredVoiceIndex ? -18 : 34;
  }

  return cost;
}

function tieCountCost(chord: ScoreChord, voice: VoiceState): number {
  if (voice.endTicks <= chord.startTicks) {
    return 0;
  }

  const overlap = voice.endTicks - chord.startTicks;
  return 40 + Math.min(40, overlap / 24);
}

function restComplexityCost(chord: ScoreChord, voice: VoiceState, voiceIndex: number, ppq: number): number {
  if (voice.averagePitch === null || voice.endTicks >= chord.startTicks) {
    return 0;
  }

  const gapTicks = chord.startTicks - voice.endTicks;
  const restUnitTicks = Math.max(1, ppq / 2);
  const longGapCost = Math.min(18, gapTicks / restUnitTicks);
  const offbeatCost = voice.lastStartTicks > 0 && gapTicks % restUnitTicks !== 0 ? 8 : 0;

  return longGapCost + offbeatCost + voiceIndex * 1.5;
}

function voiceLaneCost(averagePitchValue: number, voiceIndex: number, hasActiveOverlap: boolean): number {
  if (!hasActiveOverlap) {
    return voiceIndex === 0 ? 0 : 2.5;
  }

  if (voiceIndex === 0) {
    return Math.max(0, 58 - averagePitchValue) * 0.8;
  }

  return Math.max(0, averagePitchValue - 62) * 0.8;
}

function hasAnyActiveVoice(chord: ScoreChord, voices: VoiceState[]): boolean {
  return voices.some((voice) => voice.endTicks > chord.startTicks);
}

function advanceVoice(voice: VoiceState, chord: ScoreChord): VoiceState {
  return {
    endTicks: Math.max(voice.endTicks, chord.endTicks),
    averagePitch: averagePitch(chord),
    lastStartTicks: chord.startTicks
  };
}

function createMeasureWindows(chords: ScoreChord[]): ScoreChord[][] {
  const windows: ScoreChord[][] = [];
  let cursor = 0;

  while (cursor < chords.length) {
    let end = Math.min(chords.length, cursor + MAX_WINDOW_CHORDS);
    while (end < chords.length && chords[end].startTicks === chords[end - 1].startTicks) {
      end += 1;
    }

    const window = chords.slice(cursor, end);
    windows.push(window);
    cursor += window.length;
  }

  return windows;
}

function pruneSearchStates(states: SearchState[]): SearchState[] {
  const bestBySignature = new Map<string, SearchState>();

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
    .sort((a, b) => a.cost - b.cost || a.illegalOverlapTicks - b.illegalOverlapTicks)
    .slice(0, MAX_SEARCH_STATES);
}

function expireVoiceStates(voices: VoiceState[], tick: number) {
  for (const voice of voices) {
    if (voice.endTicks <= tick) {
      voice.endTicks = tick;
    }
  }
}

function copyVoiceStates(target: VoiceState[], source: VoiceState[]) {
  for (const [index, voice] of source.entries()) {
    target[index] = { ...voice };
  }
}

function emptyVoiceState(): VoiceState {
  return {
    endTicks: 0,
    averagePitch: null,
    lastStartTicks: 0
  };
}

function averagePitch(chord: ScoreChord): number {
  return chord.notes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, chord.notes.length);
}

function durationTicks(chord: ScoreChord): number {
  return chord.endTicks - chord.startTicks;
}
