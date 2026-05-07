import type { ScoreDraft } from "../score";
import type { PlaybackMapEntry } from "./types";

export function buildPlaybackMap(score: ScoreDraft): PlaybackMapEntry[] {
  const entries: PlaybackMapEntry[] = [];

  for (const part of score.parts) {
    for (const staff of part.staves) {
      for (const event of staff.events) {
        if (event.kind === "rest") {
          continue;
        }

        entries.push({
          elementId: event.id,
          partId: part.id,
          measureIndex: event.measureIndex,
          staffIndex: event.staffIndex,
          voiceIndex: event.voiceIndex,
          startMs: event.startMs,
          endMs: event.endMs,
          startTicks: event.startTicks,
          endTicks: event.endTicks,
          kind: event.kind
        });
      }
    }
  }

  return entries.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}
