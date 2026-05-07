import type { ActiveScorePosition, PlaybackMapEntry } from "./types";

export function findActiveScorePosition(
  entries: PlaybackMapEntry[],
  positionMs: number
): ActiveScorePosition {
  const activeIds = new Set<string>();
  let pastMeasureIndex = -1;
  let activeMeasureIndex = -1;
  const endIndex = findLastStartedEntry(entries, positionMs);

  for (let index = endIndex; index >= 0; index -= 1) {
    const entry = entries[index];

    if (positionMs <= Math.max(entry.endMs, entry.startMs + 120)) {
      activeIds.add(entry.elementId);
      activeMeasureIndex = activeMeasureIndex < 0 ? entry.measureIndex : Math.min(activeMeasureIndex, entry.measureIndex);
    } else if (pastMeasureIndex < 0 && entry.endMs < positionMs) {
      pastMeasureIndex = Math.max(pastMeasureIndex, entry.measureIndex);
    }
  }

  if (activeMeasureIndex < 0 && pastMeasureIndex >= 0) {
    activeMeasureIndex = pastMeasureIndex;
  }

  return {
    activeIds,
    pastMeasureIndex,
    activeMeasureIndex
  };
}

export function findSeekPositionForElement(entries: PlaybackMapEntry[], elementId: string): number | null {
  const entry = entries.find((item) => item.elementId === elementId);
  return entry ? entry.startMs : null;
}

function findLastStartedEntry(entries: PlaybackMapEntry[], positionMs: number): number {
  let low = 0;
  let high = entries.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (entries[mid].startMs <= positionMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return candidate;
}
