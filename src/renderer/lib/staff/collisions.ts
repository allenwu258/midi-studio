import type { RenderBox, RenderEvent, RenderGlyphBox, RenderStaff } from "./types";

const MIN_EVENT_GAP = 4;
const MAX_SHIFT = 28;

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
    avoidLayeredGlyphCollisions(measureEvents);
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
    }
  }
}

function avoidLayeredGlyphCollisions(events: RenderEvent[]) {
  const sorted = [...events].sort(
    (a, b) => a.x - b.x || a.event.startTicks - b.event.startTicks || a.event.voiceIndex - b.event.voiceIndex
  );
  const settled: RenderEvent[] = [];

  for (const current of sorted) {
    let shifted = 0;

    for (let pass = 0; pass < 3; pass += 1) {
      const requiredShift = Math.max(0, ...settled.map((previous) => collisionShift(previous, current)));
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

    settled.push(current);
  }
}

function availableRightShift(event: RenderEvent): number {
  const right = Math.max(...event.glyphBoxes.map((box) => box.x + box.width));
  const measureRight = event.measure.x + event.measure.width - 2;
  return Math.max(0, measureRight - right);
}

function collisionShift(previous: RenderEvent, current: RenderEvent): number {
  if (current.event.startTicks <= previous.event.startTicks) {
    return 0;
  }

  let shift = 0;
  for (const previousBox of previous.glyphBoxes) {
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
  event.glyphBoxes = event.event.kind === "rest" ? restBoxes(event) : chordBoxes(event);
  event.box = unionBoxes(event.glyphBoxes);
}

function restBoxes(event: RenderEvent): RenderGlyphBox[] {
  const boxes: RenderGlyphBox[] = [
    { layer: "rest", x: event.x - 8, y: event.restY - 18, width: 18, height: 22 }
  ];

  for (let index = 0; index < event.event.dots; index += 1) {
    boxes.push({ layer: "rest", x: event.x + 12 + index * 7, y: event.restY - 11, width: 5, height: 5 });
  }

  return boxes;
}

function chordBoxes(event: RenderEvent): RenderGlyphBox[] {
  const boxes: RenderGlyphBox[] = [];
  const highestY = Math.min(...event.notes.map((note) => note.y));
  const lowestY = Math.max(...event.notes.map((note) => note.y));

  for (const note of event.notes) {
    boxes.push({ layer: "notehead", x: note.noteHeadX - 9, y: note.y - 7, width: 18, height: 14 });
    if (note.note.alter !== 0) {
      boxes.push({ layer: "accidental", x: note.accidentalX - 7, y: note.y - 13, width: 14, height: 18 });
    }
  }

  for (let index = 0; index < event.event.dots; index += 1) {
    boxes.push({ layer: "notehead", x: event.x + 14 + index * 7, y: highestY - 3, width: 5, height: 5 });
  }

  if (event.event.kind === "chord" && event.event.tieStart) {
    boxes.push({ layer: "tie", x: event.x - 5, y: lowestY + 10, width: 105, height: 24 });
  }

  return boxes;
}

function unionBoxes(boxes: RenderGlyphBox[]): RenderBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

function boxesOverlapY(a: RenderBox, b: RenderBox): boolean {
  return a.y < b.y + b.height && b.y < a.y + a.height;
}
