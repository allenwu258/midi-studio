import type { PlaybackMapEntry } from "../../lib/playbackMap";
import type { RenderSystem } from "../../lib/staff";
import type { ActiveRenderEvent } from "./activeEvents";

export type PlaybackCursor = {
  x: number;
  y1: number;
  y2: number;
  system: Pick<RenderSystem, "index" | "y" | "height">;
};

type CursorEvent = {
  entry: PlaybackMapEntry;
  activeEvent: ActiveRenderEvent;
};

export function createPlaybackCursor(
  playbackPositionMs: number,
  playbackMap: PlaybackMapEntry[],
  activeEventIndex: Map<string, ActiveRenderEvent>
): PlaybackCursor | null {
  const cursorEvent = findCursorEvent(playbackPositionMs, playbackMap, activeEventIndex);
  if (!cursorEvent) {
    return null;
  }

  const x = interpolatedCursorX(cursorEvent, playbackPositionMs, playbackMap, activeEventIndex);

  return {
    x,
    y1: cursorEvent.activeEvent.system.y + 10,
    y2: cursorEvent.activeEvent.system.y + cursorEvent.activeEvent.system.height - 10,
    system: cursorEvent.activeEvent.system
  };
}

function interpolatedCursorX(
  cursorEvent: CursorEvent,
  playbackPositionMs: number,
  playbackMap: PlaybackMapEntry[],
  activeEventIndex: Map<string, ActiveRenderEvent>
): number {
  const currentX = cursorEvent.activeEvent.event.box.x + cursorEvent.activeEvent.event.box.width / 2;
  const currentEntry = cursorEvent.entry;

  if (playbackPositionMs <= currentEntry.startMs) {
    return currentX;
  }

  const nextEntry = playbackMap.find(
    (entry) =>
      entry.startMs > currentEntry.startMs &&
      activeEventIndex.get(entry.elementId)?.system === cursorEvent.activeEvent.system
  );
  const nextActiveEvent = nextEntry ? activeEventIndex.get(nextEntry.elementId) : undefined;

  if (!nextEntry || !nextActiveEvent || nextEntry.startMs <= currentEntry.startMs) {
    return currentX;
  }

  const nextX = nextActiveEvent.event.box.x + nextActiveEvent.event.box.width / 2;
  const progress = clamp01(
    (playbackPositionMs - currentEntry.startMs) / (nextEntry.startMs - currentEntry.startMs)
  );

  return currentX + (nextX - currentX) * progress;
}

function findCursorEvent(
  playbackPositionMs: number,
  playbackMap: PlaybackMapEntry[],
  activeEventIndex: Map<string, ActiveRenderEvent>
): CursorEvent | null {
  for (let index = playbackMap.length - 1; index >= 0; index -= 1) {
    const entry = playbackMap[index];
    if (entry.startMs > playbackPositionMs) {
      continue;
    }

    const activeEvent = activeEventIndex.get(entry.elementId);
    if (activeEvent) {
      return { entry, activeEvent };
    }
  }

  const firstEntry = playbackMap.find((entry) => activeEventIndex.has(entry.elementId));
  const firstActiveEvent = firstEntry ? activeEventIndex.get(firstEntry.elementId) : undefined;

  return firstEntry && firstActiveEvent
    ? { entry: firstEntry, activeEvent: firstActiveEvent }
    : null;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
