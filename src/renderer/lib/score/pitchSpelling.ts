import type { Clef, ScorePitch } from "./types";

const SHARP_STEPS = [
  { step: "C", alter: 0 },
  { step: "C", alter: 1 },
  { step: "D", alter: 0 },
  { step: "D", alter: 1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "F", alter: 1 },
  { step: "G", alter: 0 },
  { step: "G", alter: 1 },
  { step: "A", alter: 0 },
  { step: "A", alter: 1 },
  { step: "B", alter: 0 }
] as const;

const STEP_INDEX: Record<ScorePitch["step"], number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6
};

export function spellMidiPitch(midi: number): ScorePitch {
  const pitchClass = ((midi % 12) + 12) % 12;
  const spelling = SHARP_STEPS[pitchClass];

  return {
    midi,
    step: spelling.step,
    alter: spelling.alter,
    octave: Math.floor(midi / 12) - 1
  };
}

export function chooseClefForTrack(averagePitch: number, isDrum: boolean): Clef {
  if (isDrum) {
    return "percussion";
  }

  return averagePitch < 58 ? "bass" : "treble";
}

export function staffYForPitch(pitch: ScorePitch, clef: Clef, staffTop: number, lineGap: number): number {
  if (clef === "percussion") {
    return staffTop + lineGap * 2;
  }

  const pitchPosition = pitch.octave * 7 + STEP_INDEX[pitch.step];
  const bottomLinePosition = clef === "bass" ? 18 : 30;
  return staffTop + lineGap * 4 - (pitchPosition - bottomLinePosition) * (lineGap / 2);
}

export function accidentalText(alter: ScorePitch["alter"]): string {
  if (alter > 0) {
    return "#";
  }
  if (alter < 0) {
    return "b";
  }
  return "";
}
