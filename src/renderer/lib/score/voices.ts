import type { ScoreChord, ScoreDiagnostic } from "./types";

const DEFAULT_VOICE_LIMIT = 2;
const OVERLAP_PENALTY = 10_000;

type VoiceState = {
  endTicks: number;
  averagePitch: number | null;
  lastStartTicks: number;
};

export function assignVoices(
  chords: ScoreChord[],
  trackIndex: number,
  diagnostics: ScoreDiagnostic[],
  voiceLimit = DEFAULT_VOICE_LIMIT
): number {
  const sortedChords = chords.sort((a, b) => a.startTicks - b.startTicks || averagePitch(b) - averagePitch(a));
  const preferredVoices = inferPreferredVoices(sortedChords, voiceLimit);
  const voiceStates: VoiceState[] = Array.from({ length: voiceLimit }, () => ({
    endTicks: 0,
    averagePitch: null,
    lastStartTicks: 0
  }));
  let usedVoiceCount = 1;
  let reportedLimit = false;

  for (const chord of sortedChords) {
    const activeVoiceIndexes = voiceStates
      .map((state, index) => ({ state, index }))
      .filter(({ state }) => state.endTicks > chord.startTicks)
      .map(({ index }) => index);
    const voiceIndex = chooseVoiceIndex(chord, voiceStates, activeVoiceIndexes, preferredVoices.get(chord.id));

    if (voiceStates[voiceIndex].endTicks > chord.startTicks && !reportedLimit) {
      diagnostics.push({
        severity: "warning",
        code: "VOICE_LIMIT_EXCEEDED",
        message: "检测到超过当前基础声部分离能力的复调片段，部分音符可能仍会重叠显示。",
        trackIndex,
        tick: chord.startTicks
      });
      reportedLimit = true;
    }

    chord.voiceIndex = voiceIndex;
    voiceStates[voiceIndex] = {
      endTicks: Math.max(voiceStates[voiceIndex].endTicks, chord.endTicks),
      averagePitch: averagePitch(chord),
      lastStartTicks: chord.startTicks
    };
    usedVoiceCount = Math.max(usedVoiceCount, voiceIndex + 1);
  }

  return usedVoiceCount;
}

function chooseVoiceIndex(
  chord: ScoreChord,
  voiceStates: VoiceState[],
  activeVoiceIndexes: number[],
  preferredVoiceIndex?: number
): number {
  let bestVoiceIndex = 0;
  let bestCost = Number.POSITIVE_INFINITY;

  for (let voiceIndex = 0; voiceIndex < voiceStates.length; voiceIndex += 1) {
    const cost = voiceCost(chord, voiceStates[voiceIndex], voiceIndex, activeVoiceIndexes, preferredVoiceIndex);
    if (cost < bestCost) {
      bestCost = cost;
      bestVoiceIndex = voiceIndex;
    }
  }

  return bestVoiceIndex;
}

function voiceCost(
  chord: ScoreChord,
  voiceState: VoiceState,
  voiceIndex: number,
  activeVoiceIndexes: number[],
  preferredVoiceIndex?: number
): number {
  const chordAverage = averagePitch(chord);
  const overlapTicks = Math.max(0, voiceState.endTicks - chord.startTicks);
  const overlapCost = overlapTicks > 0 ? OVERLAP_PENALTY + overlapTicks * 0.5 : 0;
  const continuityCost =
    voiceState.averagePitch === null ? 0 : Math.abs(chordAverage - voiceState.averagePitch) * 0.35;
  const voiceActivationCost = voiceIndex * (activeVoiceIndexes.length ? 1.5 : 8);
  const laneCost = voiceLaneCost(chordAverage, voiceIndex, activeVoiceIndexes.length > 0);
  const gapTicks = Math.max(0, chord.startTicks - voiceState.endTicks);
  const gapCost = voiceState.averagePitch === null ? 0 : Math.min(5, gapTicks / 960);
  const preferenceCost = preferredVoiceIndex === undefined || preferredVoiceIndex === voiceIndex ? 0 : 18;

  return overlapCost + continuityCost + voiceActivationCost + laneCost + gapCost + preferenceCost;
}

function voiceLaneCost(averagePitchValue: number, voiceIndex: number, hasActiveOverlap: boolean): number {
  if (!hasActiveOverlap) {
    return 0;
  }

  if (voiceIndex === 0) {
    return Math.max(0, 58 - averagePitchValue) * 0.35;
  }

  return Math.max(0, averagePitchValue - 62) * 0.35;
}

function averagePitch(chord: ScoreChord): number {
  return chord.notes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, chord.notes.length);
}

function inferPreferredVoices(chords: ScoreChord[], voiceLimit: number): Map<string, number> {
  const result = new Map<string, number>();
  if (voiceLimit < 2) {
    return result;
  }

  for (const chord of chords) {
    const chordAverage = averagePitch(chord);
    const overlappingHigher = chords.some(
      (candidate) =>
        candidate.startTicks > chord.startTicks &&
        candidate.startTicks < chord.endTicks &&
        averagePitch(candidate) > chordAverage + 5
    );
    if (overlappingHigher && durationTicks(chord) >= durationTicksForSupport(chords)) {
      result.set(chord.id, 1);
    }
  }

  for (const group of groupByStartTicks(chords)) {
    const hasUnequalDurations = new Set(group.map((chord) => chord.endTicks)).size > 1;
    if (!hasUnequalDurations || group.length < 2) {
      continue;
    }

    const byPitch = [...group].sort((a, b) => averagePitch(b) - averagePitch(a));
    const lowerLonger = byPitch[byPitch.length - 1];
    const upperShorter = byPitch[0];
    if (durationTicks(lowerLonger) > durationTicks(upperShorter)) {
      result.set(lowerLonger.id, 1);
      result.set(upperShorter.id, 0);
    }
  }

  return result;
}

function groupByStartTicks(chords: ScoreChord[]): ScoreChord[][] {
  const groups = new Map<number, ScoreChord[]>();
  for (const chord of chords) {
    groups.set(chord.startTicks, [...(groups.get(chord.startTicks) ?? []), chord]);
  }
  return [...groups.values()];
}

function durationTicks(chord: ScoreChord): number {
  return chord.endTicks - chord.startTicks;
}

function durationTicksForSupport(chords: ScoreChord[]): number {
  const durations = chords.map(durationTicks).sort((a, b) => a - b);
  return durations[Math.floor(durations.length * 0.6)] ?? 0;
}
