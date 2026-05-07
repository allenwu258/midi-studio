import type { RenderBox, RenderEvent, RenderGlyphBox, RenderStaff } from "./types";
import { accidentalColumns, chordGlyphBoxes, restGlyphBoxes, unionBoxes } from "./glyphMetrics";

const MIN_EVENT_GAP = 4;
const MAX_SHIFT = 28;

type Skyline = {
  boxes: RenderGlyphBox[];
};

export function avoidStaffCollisions(staff: RenderStaff): RenderStaff {
  const events = staff.events.map((event) => ({
    ...event,
    notes: event.notes.map((note) => ({ ...note })),
    glyphBoxes: event.glyphBoxes.map((box) => ({ ...box }))
  }));
  const grouped = groupEventsByMeasure(events);

  for (const measureEvents of grouped.values()) {
    separateVisibleRests(measureEvents);
    spreadAccidentals(measureEvents);
    syncEventBoxes(measureEvents);
    avoidSkylineCollisions(measureEvents);
    syncEventBoxes(measureEvents);
  }

  return {
    ...staff,
    events
  };
}

function groupEventsByMeasure(events: RenderEvent[]): Map<number, RenderEvent[]> {
  const grouped = new Map<number, RenderEvent[]>();

  for (const event of events) {
    grouped.set(event.measure.measure.index, [...(grouped.get(event.measure.measure.index) ?? []), event]);
  }

  return grouped;
}

function spreadAccidentals(events: RenderEvent[]) {
  const chordEvents = events.filter((event) => event.event.kind === "chord");

  for (const event of chordEvents) {
    accidentalColumns(event.notes, event.x);
  }
}

function separateVisibleRests(events: RenderEvent[]) {
  for (const event of events) {
    if (event.event.kind !== "rest") {
      continue;
    }

    if (event.event.voiceIndex === 1) {
      event.restY += 16;
    }
  }
}

function avoidSkylineCollisions(events: RenderEvent[]) {
  const sorted = [...events].sort(
    (a, b) => a.x - b.x || a.event.startTicks - b.event.startTicks || a.event.voiceIndex - b.event.voiceIndex
  );
  const skyline: Skyline = { boxes: [] };

  for (const current of sorted) {
    let shifted = 0;

    for (let pass = 0; pass < 3; pass += 1) {
      const requiredShift = skylineShift(skyline, current);
      const allowedShift = Math.min(MAX_SHIFT - shifted, requiredShift, availableRightShift(current));

      if (allowedShift <= 0) {
        break;
      }

      shiftEvent(current, allowedShift);
      shifted += allowedShift;
      syncEventBox(current);

      if (shifted >= MAX_SHIFT) {
        break;
      }
    }

    skyline.boxes.push(...current.glyphBoxes);
  }
}

function availableRightShift(event: RenderEvent): number {
  const right = Math.max(...event.glyphBoxes.map((box) => box.x + box.width));
  const measureRight = event.measure.x + event.measure.width - 2;
  return Math.max(0, measureRight - right);
}

function skylineShift(skyline: Skyline, current: RenderEvent): number {
  let shift = 0;
  for (const previousBox of skyline.boxes) {
    for (const currentBox of current.glyphBoxes) {
      if (!shouldAvoidCollision(previousBox, currentBox) || !boxesOverlapY(previousBox, currentBox)) {
        continue;
      }

      const overlap = previousBox.x + previousBox.width + MIN_EVENT_GAP - currentBox.x;
      if (overlap > 0) {
        shift = Math.max(shift, overlap);
      }
    }
  }

  return shift;
}

function shouldAvoidCollision(previous: RenderGlyphBox, current: RenderGlyphBox): boolean {
  if (previous.layer === "tie" && current.layer === "tie") {
    return false;
  }

  if (previous.layer === "accidental" && current.layer === "accidental") {
    return false;
  }

  return true;
}

function shiftEvent(event: RenderEvent, amount: number) {
  event.x += amount;
  event.box.x += amount;
  for (const note of event.notes) {
    note.noteHeadX += amount;
    note.accidentalX += amount;
  }
  for (const box of event.glyphBoxes) {
    box.x += amount;
  }
}

function syncEventBoxes(events: RenderEvent[]) {
  for (const event of events) {
    syncEventBox(event);
  }
}

function syncEventBox(event: RenderEvent) {
  event.glyphBoxes = event.event.kind === "rest"
    ? restGlyphBoxes(event.x, event.restY, event.event.dots)
    : chordGlyphBoxes({
        event: event.event,
        notes: event.notes,
        x: event.x,
        stemDirection: event.stemDirection ?? "up",
        stemLength: 42
      });
  event.box = unionBoxes(event.glyphBoxes);
}

function boxesOverlapY(a: RenderBox, b: RenderBox): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}
