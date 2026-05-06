const KEY_TO_PITCH_CLASS: Record<string, number> = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
  Cb: 11
};

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const DEGREE_LABELS = ["1", "2", "3", "4", "5", "6", "7"];

export function normalizeKeyName(key?: string): string {
  if (!key) {
    return "C";
  }

  const trimmed = key.trim();
  return KEY_TO_PITCH_CLASS[trimmed] === undefined ? "C" : trimmed;
}

export function midiToNumberedNotation(midi: number, keyName = "C"): string {
  const tonic = KEY_TO_PITCH_CLASS[normalizeKeyName(keyName)];
  const pitchClass = ((midi % 12) + 12) % 12;
  const offset = (pitchClass - tonic + 12) % 12;
  const exactDegree = MAJOR_SCALE.indexOf(offset);

  let label: string;
  if (exactDegree >= 0) {
    label = DEGREE_LABELS[exactDegree];
  } else {
    const sharpBase = MAJOR_SCALE.findIndex((step) => (step + 1) % 12 === offset);
    const flatBase = MAJOR_SCALE.findIndex((step) => (step + 11) % 12 === offset);

    if (sharpBase >= 0) {
      label = `#${DEGREE_LABELS[sharpBase]}`;
    } else if (flatBase >= 0) {
      label = `b${DEGREE_LABELS[flatBase]}`;
    } else {
      label = "?";
    }
  }

  const octaveShift = Math.floor((midi - 60) / 12);
  if (octaveShift > 0) {
    return `${label}${"'".repeat(Math.min(octaveShift, 3))}`;
  }
  if (octaveShift < 0) {
    return `${label}${",".repeat(Math.min(Math.abs(octaveShift), 3))}`;
  }
  return label;
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "00:00";
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
