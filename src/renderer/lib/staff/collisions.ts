import type { RenderEvent, RenderStaff } from "./types";

const MIN_EVENT_GAP = 4;
const MAX_SHIFT = 20;

export function avoidStaffCollisions(staff: RenderStaff): RenderStaff {
  const events = staff.events.map((event) => ({ ...event, notes: event.notes.map((note) => ({ ...note })) }));
  const grouped = groupEventsByMeasure(events);

  for (const measureEvents of grouped.values()) {
    avoidEventBoxes(measureEvents);
    spreadAccidentals(measureEvents);
    separateVisibleRests(measureEvents);
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

function avoidEventBoxes(events: RenderEvent[]) {
  const sorted = events
    .filter((event) => event.event.kind === "chord")
    .sort((a, b) => a.x - b.x || a.event.voiceIndex - b.event.voiceIndex);

  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const overlap = previous.box.x + previous.box.width + MIN_EVENT_GAP - current.box.x;

    if (overlap > 0 && current.event.startTicks >= previous.event.startTicks) {
      shiftEvent(current, Math.min(MAX_SHIFT, overlap));
    }
  }
}

function spreadAccidentals(events: RenderEvent[]) {
  const chordEvents = events.filter((event) => event.event.kind === "chord");

  for (const event of chordEvents) {
    const accidentalNotes = event.notes
      .filter((note) => note.note.alter !== 0)
      .sort((a, b) => a.y - b.y);
    let lastY = Number.NEGATIVE_INFINITY;
    let column = 0;

    for (const note of accidentalNotes) {
      if (note.y - lastY < 12) {
        column += 1;
      } else {
        column = 0;
      }

      note.accidentalX = event.x - 24 - column * 9;
      lastY = note.y;
    }
  }
}

function separateVisibleRests(events: RenderEvent[]) {
  for (const event of events) {
    if (event.event.kind !== "rest") {
      continue;
    }

    if (event.event.voiceIndex === 1) {
      event.restY += 16;
      event.box.y += 16;
    }
  }
}

function shiftEvent(event: RenderEvent, amount: number) {
  event.x += amount;
  event.box.x += amount;
  for (const note of event.notes) {
    note.accidentalX += amount;
  }
}
