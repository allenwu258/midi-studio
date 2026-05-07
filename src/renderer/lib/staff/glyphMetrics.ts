import type { ScoreEvent, ScoreNote } from "../score";
import type { RenderBox, RenderGlyphBox, RenderGlyphLayer, RenderNote, StemDirection } from "./types";

type GlyphName = "notehead" | "accidental" | "rest" | "dot" | "stem" | "tie";

type GlyphMetric = {
  layer: RenderGlyphLayer;
  left: number;
  top: number;
  width: number;
  height: number;
};

const GLYPH_METRICS: Record<GlyphName, GlyphMetric> = {
  notehead: { layer: "notehead", left: -9, top: -7, width: 18, height: 14 },
  accidental: { layer: "accidental", left: -7, top: -13, width: 14, height: 18 },
  rest: { layer: "rest", left: -8, top: -18, width: 18, height: 22 },
  dot: { layer: "dot", left: -2.5, top: -2.5, width: 5, height: 5 },
  stem: { layer: "stem", left: -1.5, top: 0, width: 3, height: 42 },
  tie: { layer: "tie", left: -5, top: 10, width: 105, height: 24 }
};

export function noteheadWidth(): number {
  return GLYPH_METRICS.notehead.width;
}

export function restGlyphBoxes(x: number, restY: number, dots: number): RenderGlyphBox[] {
  const boxes = [boxAt("rest", x, restY)];

  for (let index = 0; index < dots; index += 1) {
    boxes.push(boxAt("dot", x + 14 + index * 7, restY - 8));
  }

  return boxes;
}

export function chordGlyphBoxes({
  event,
  notes,
  x,
  stemDirection,
  stemLength
}: {
  event: Extract<ScoreEvent, { kind: "chord" }>;
  notes: RenderNote[];
  x: number;
  stemDirection: StemDirection;
  stemLength: number;
}): RenderGlyphBox[] {
  const boxes: RenderGlyphBox[] = [];
  const highestY = Math.min(...notes.map((note) => note.y));
  const lowestY = Math.max(...notes.map((note) => note.y));

  for (const note of notes) {
    boxes.push(boxAt("notehead", note.noteHeadX, note.y));
    if (note.note.accidental !== undefined) {
      boxes.push(boxAt("accidental", note.accidentalX, note.y));
    }
  }

  for (let index = 0; index < event.dots; index += 1) {
    boxes.push(boxAt("dot", x + 16 + index * 7, highestY));
  }

  if (event.tieStart) {
    boxes.push(boxAt("tie", x, lowestY));
  }

  const stemX = stemDirection === "up" ? x + 7 : x - 7;
  const stemY = stemDirection === "up" ? highestY - stemLength : lowestY;
  boxes.push({ ...boxAt("stem", stemX, stemY), height: stemLength });

  return boxes;
}

export function accidentalColumns(notes: RenderNote[], baseX: number): RenderNote[] {
  const accidentalNotes = notes
    .filter((note) => note.note.accidental !== undefined)
    .sort((a, b) => a.y - b.y);
  let lastY = Number.NEGATIVE_INFINITY;
  let column = 0;

  for (const note of accidentalNotes) {
    if (note.y - lastY < 12) {
      column += 1;
    } else {
      column = 0;
    }

    note.accidentalX = baseX - 24 - column * 9;
    lastY = note.y;
  }

  return notes;
}

export function glyphProfileForEvent(event: ScoreEvent): { minLeft: number; minRight: number } {
  if (event.kind === "rest") {
    return {
      minLeft: Math.abs(GLYPH_METRICS.rest.left) + 1,
      minRight: GLYPH_METRICS.rest.width + event.dots * 7
    };
  }

  const accidentalCount = event.notes.filter((note: ScoreNote) => note.accidental !== undefined).length;
  const closeIntervals = countCloseChordIntervals(event.notes);
  const dotWidth = event.dots * 7;
  const tieWidth = event.tieStart ? GLYPH_METRICS.tie.width : 0;

  return {
    minLeft: Math.abs(GLYPH_METRICS.notehead.left) + accidentalCount * 9 + closeIntervals * 5,
    minRight: GLYPH_METRICS.notehead.width + dotWidth + tieWidth + closeIntervals * 5
  };
}

export function unionBoxes(boxes: RenderGlyphBox[]): RenderBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

function boxAt(name: GlyphName, originX: number, originY: number): RenderGlyphBox {
  const metric = GLYPH_METRICS[name];
  return {
    layer: metric.layer,
    x: originX + metric.left,
    y: originY + metric.top,
    width: metric.width,
    height: metric.height
  };
}

function countCloseChordIntervals(notes: ScoreNote[]): number {
  const sorted = [...notes].sort((a, b) => a.midi - b.midi);
  let count = 0;

  for (let index = 1; index < sorted.length; index += 1) {
    const distance = Math.abs(sorted[index].midi - sorted[index - 1].midi);
    if (distance <= 2) {
      count += 1;
    }
  }

  return count;
}
