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
  const voiceStates: VoiceState[] = Array.from({ length: voiceLimit }, () => ({
    endTicks: 0,
    averagePitch: null,
    lastStartTicks: 0
  }));
  let usedVoiceCount = 1;
  let reportedLimit = false;

  for (const chord of chords.sort((a, b) => a.startTicks - b.startTicks || averagePitch(b) - averagePitch(a))) {
    const activeVoiceIndexes = voiceStates
      .map((state, index) => ({ state, index }))
      .filter(({ state }) => state.endTicks > chord.startTicks)
      .map(({ index }) => index);
    const voiceIndex = chooseVoiceIndex(chord, voiceStates, activeVoiceIndexes);

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
  activeVoiceIndexes: number[]
): number {
  let bestVoiceIndex = 0;
  let bestCost = Number.POSITIVE_INFINITY;

  for (let voiceIndex = 0; voiceIndex < voiceStates.length; voiceIndex += 1) {
    const cost = voiceCost(chord, voiceStates[voiceIndex], voiceIndex, activeVoiceIndexes);
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
  activeVoiceIndexes: number[]
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

  return overlapCost + continuityCost + voiceActivationCost + laneCost + gapCost;
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
