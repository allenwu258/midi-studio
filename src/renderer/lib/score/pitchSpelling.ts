import type { ParsedMidiMeta } from "../midi";
import type { Clef, QuantizedNote, ScoreMeasure, ScorePitch } from "./types";

type PitchClassSpelling = Pick<ScorePitch, "step" | "alter">;
type KeySignatureLike = ParsedMidiMeta["keySignatures"][number];

const SHARP_STEPS: PitchClassSpelling[] = [
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
];

const FLAT_STEPS: PitchClassSpelling[] = [
  { step: "C", alter: 0 },
  { step: "D", alter: -1 },
  { step: "D", alter: 0 },
  { step: "E", alter: -1 },
  { step: "E", alter: 0 },
  { step: "F", alter: 0 },
  { step: "G", alter: -1 },
  { step: "G", alter: 0 },
  { step: "A", alter: -1 },
  { step: "A", alter: 0 },
  { step: "B", alter: -1 },
  { step: "B", alter: 0 }
];

const KEY_FIFTHS: Record<string, number> = {
  C: 0,
  G: 1,
  D: 2,
  A: 3,
  E: 4,
  B: 5,
  "F#": 6,
  "C#": 7,
  F: -1,
  Bb: -2,
  Eb: -3,
  Ab: -4,
  Db: -5,
  Gb: -6,
  Cb: -7,
  Am: 0,
  Em: 1,
  Bm: 2,
  "F#m": 3,
  "C#m": 4,
  "G#m": 5,
  "D#m": 6,
  "A#m": 7,
  Dm: -1,
  Gm: -2,
  Cm: -3,
  Fm: -4,
  Bbm: -5,
  Ebm: -6,
  Abm: -7
};

const SHARP_ORDER: ScorePitch["step"][] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: ScorePitch["step"][] = ["B", "E", "A", "D", "G", "C", "F"];

export const STEP_INDEX: Record<ScorePitch["step"], number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6
};

export function createPitchSpellings(
  notes: QuantizedNote[],
  measures: ScoreMeasure[],
  keySignatures: KeySignatureLike[]
): Map<string, ScorePitch> {
  const result = new Map<string, ScorePitch>();
  const sorted = [...notes].sort((a, b) => a.quantizedStartTicks - b.quantizedStartTicks || a.midi - b.midi);
  let currentMeasureIndex = -1;
  let accidentalMemory = new Map<string, ScorePitch["alter"]>();
  let previousPitch: ScorePitch | null = null;

  for (const note of sorted) {
    const measure = measureForTicks(note.quantizedStartTicks, measures);
    if (measure.index !== currentMeasureIndex) {
      currentMeasureIndex = measure.index;
      accidentalMemory = new Map();
    }

    const keyMap = keyAlterMap(keyForTicks(note.quantizedStartTicks, keySignatures));
    const pitch = spellMidiPitch(note.midi, keyMap, accidentalMemory, previousPitch);
    result.set(note.id, pitch);
    accidentalMemory.set(accidentalMemoryKey(pitch), pitch.alter);
    previousPitch = pitch;
  }

  return result;
}

export function spellMidiPitch(
  midi: number,
  keyMap: Map<ScorePitch["step"], ScorePitch["alter"]> = new Map(),
  accidentalMemory: Map<string, ScorePitch["alter"]> = new Map(),
  previousPitch: ScorePitch | null = null
): ScorePitch {
  const candidates = spellingCandidates(midi);
  const best = candidates
    .map((candidate) => ({
      candidate,
      cost: spellingCost(candidate, keyMap, accidentalMemory, previousPitch)
    }))
    .sort((a, b) => a.cost - b.cost || STEP_INDEX[a.candidate.step] - STEP_INDEX[b.candidate.step])[0].candidate;
  const keyAlter = keyMap.get(best.step) ?? 0;
  const memoryKey = accidentalMemoryKey(best);
  const activeAlter = accidentalMemory.has(memoryKey) ? accidentalMemory.get(memoryKey) ?? 0 : keyAlter;
  const accidental = activeAlter === best.alter ? undefined : best.alter;

  return {
    ...best,
    accidental,
    midi,
    octave: octaveForSpelling(midi, best)
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

export function accidentalText(alter: ScorePitch["accidental"]): string {
  if (alter === 0) {
    return "♮";
  }
  if (alter && alter > 0) {
    return "#";
  }
  if (alter && alter < 0) {
    return "b";
  }
  return "";
}

function spellingCandidates(midi: number): ScorePitch[] {
  const pitchClass = ((midi % 12) + 12) % 12;
  const spellings = [SHARP_STEPS[pitchClass], FLAT_STEPS[pitchClass]];
  const unique = new Map<string, PitchClassSpelling>();

  for (const spelling of spellings) {
    unique.set(`${spelling.step}:${spelling.alter}`, spelling);
  }

  return [...unique.values()].map((spelling) => ({
    ...spelling,
    accidental: undefined,
    midi,
    octave: octaveForSpelling(midi, spelling)
  }));
}

function spellingCost(
  pitch: ScorePitch,
  keyMap: Map<ScorePitch["step"], ScorePitch["alter"]>,
  accidentalMemory: Map<string, ScorePitch["alter"]>,
  previousPitch: ScorePitch | null
): number {
  const keyAlter = keyMap.get(pitch.step) ?? 0;
  const memoryKey = accidentalMemoryKey(pitch);
  const activeAlter = accidentalMemory.has(memoryKey) ? accidentalMemory.get(memoryKey) ?? 0 : keyAlter;
  const accidentalCost = activeAlter === pitch.alter ? 0 : 9;
  const keyCost = keyAlter === pitch.alter ? -3 : Math.abs(pitch.alter - keyAlter) * 4;
  const alterationCost = Math.abs(pitch.alter) * 1.5;
  const continuityCost = previousPitch ? Math.abs(STEP_INDEX[pitch.step] - STEP_INDEX[previousPitch.step]) * 0.18 : 0;

  return accidentalCost + keyCost + alterationCost + continuityCost;
}

function keyForTicks(ticks: number, keySignatures: KeySignatureLike[]): KeySignatureLike | undefined {
  const sorted = [...keySignatures].sort((a, b) => a.ticks - b.ticks);
  let result: KeySignatureLike | undefined;

  for (const key of sorted) {
    if (key.ticks <= ticks) {
      result = key;
    }
  }

  return result;
}

function keyAlterMap(signature?: KeySignatureLike): Map<ScorePitch["step"], ScorePitch["alter"]> {
  const fifths = fifthsForKey(signature);
  const result = new Map<ScorePitch["step"], ScorePitch["alter"]>();

  if (fifths > 0) {
    for (const step of SHARP_ORDER.slice(0, fifths)) {
      result.set(step, 1);
    }
  } else if (fifths < 0) {
    for (const step of FLAT_ORDER.slice(0, Math.abs(fifths))) {
      result.set(step, -1);
    }
  }

  return result;
}

function fifthsForKey(signature?: KeySignatureLike): number {
  if (!signature) {
    return 0;
  }

  const suffix = signature.scale?.toLowerCase() === "minor" ? "m" : "";
  return KEY_FIFTHS[`${normalizeKey(signature.key)}${suffix}`] ?? KEY_FIFTHS[normalizeKey(signature.key)] ?? 0;
}

function normalizeKey(key: string): string {
  return key.trim().replace(/([a-g])/i, (match) => match.toUpperCase()).replace("♭", "b").replace("♯", "#");
}

function octaveForSpelling(midi: number, spelling: PitchClassSpelling): number {
  const pitchClass = ((midi % 12) + 12) % 12;
  const naturalPitchClass = naturalPitchClassForStep(spelling.step);
  const spelledPitchClass = (naturalPitchClass + spelling.alter + 12) % 12;
  const baseOctave = Math.floor(midi / 12) - 1;

  return spelledPitchClass > pitchClass && pitchClass <= 1 ? baseOctave - 1 : baseOctave;
}

function naturalPitchClassForStep(step: ScorePitch["step"]): number {
  switch (step) {
    case "C":
      return 0;
    case "D":
      return 2;
    case "E":
      return 4;
    case "F":
      return 5;
    case "G":
      return 7;
    case "A":
      return 9;
    case "B":
      return 11;
  }
}

function accidentalMemoryKey(pitch: Pick<ScorePitch, "step" | "octave">): string {
  return `${pitch.step}:${pitch.octave}`;
}

function measureForTicks(ticks: number, measures: ScoreMeasure[]): ScoreMeasure {
  return measures.find((measure) => ticks >= measure.startTicks && ticks < measure.endTicks) ?? measures[measures.length - 1];
}
