import type { ScoreChord, ScoreDraft, ScoreEvent, ScoreMeasure, ScoreStaff } from "../score";
import { staffYForPitch } from "../score/pitchSpelling";
import { createBeamGroups, stemDirectionForChord } from "./beams";
import { avoidStaffCollisions } from "./collisions";
import { createSystemMeasureLayouts, estimateSystemMeasureMinWidth, partHeight, systemWidth, xForEvent } from "./spacing";
import type {
  RenderBox,
  RenderEvent,
  RenderGlyphBox,
  RenderLayoutOptions,
  RenderMeasure,
  RenderNote,
  RenderPart,
  RenderScore,
  RenderStaff,
  RenderSystem,
  RenderTuplet
} from "./types";
import { DEFAULT_RENDER_LAYOUT_OPTIONS } from "./types";

export function layoutScore(
  score: ScoreDraft,
  options: RenderLayoutOptions = DEFAULT_RENDER_LAYOUT_OPTIONS
): RenderScore {
  const systems = createSystems(score, options);
  const height = systems.length
    ? systems[systems.length - 1].y + systems[systems.length - 1].height + options.pagePadding
    : 360;
  const elementBoxes = new Map<string, RenderBox>();

  for (const system of systems) {
    for (const part of system.parts) {
      for (const staff of part.staves) {
        for (const event of staff.events) {
          elementBoxes.set(event.event.id, event.box);
        }
      }
    }
  }

  return {
    score,
    width: options.width,
    height,
    systems,
    elementBoxes
  };
}

function createSystems(score: ScoreDraft, options: RenderLayoutOptions): RenderSystem[] {
  const systems: RenderSystem[] = [];
  const systemHeight = Math.max(
    120,
    options.systemTopPadding +
      score.parts.reduce(
        (height, part, index) => height + partHeight(part.staves.length, options) + (index > 0 ? options.partGap : 0),
        0
      ) +
      options.systemBottomPadding
  );

  for (const measures of createSystemMeasureGroups(score, options)) {
    const renderMeasures = createSystemMeasureLayouts(score, measures, options);
    const y = options.pagePadding + systems.length * (systemHeight + options.systemGap);
    const parts = createRenderParts(score, renderMeasures, y, options);
    const lastMeasure = renderMeasures[renderMeasures.length - 1];
    systems.push({
      index: systems.length,
      y,
      height: systemHeight,
      endX: lastMeasure ? lastMeasure.x + lastMeasure.width : options.scoreLeft,
      measures: renderMeasures,
      parts
    });
  }

  return systems;
}

function createSystemMeasureGroups(score: ScoreDraft, options: RenderLayoutOptions): ScoreMeasure[][] {
  const groups: ScoreMeasure[][] = [];
  const maxSystemWidth = systemWidth(options);
  let index = 0;

  while (index < score.measures.length) {
    const current: ScoreMeasure[] = [];

    while (index < score.measures.length && current.length < options.measuresPerSystem) {
      const candidate = [...current, score.measures[index]];
      const candidateMinWidth = estimateSystemMeasureMinWidth(score, candidate, options);

      if (current.length > 0 && candidateMinWidth > maxSystemWidth) {
        break;
      }

      current.push(score.measures[index]);
      index += 1;

      if (candidateMinWidth > maxSystemWidth) {
        break;
      }
    }

    groups.push(current.length ? current : [score.measures[index++]]);
  }

  return groups;
}

function createRenderParts(
  score: ScoreDraft,
  measures: RenderMeasure[],
  systemY: number,
  options: RenderLayoutOptions
): RenderPart[] {
  const parts: RenderPart[] = [];
  let partTop = systemY + options.systemTopPadding;

  for (const [partIndex, part] of score.parts.entries()) {
    const currentPartTop = partTop + (partIndex > 0 ? options.partGap : 0);
    const staffTops = part.staves.map((_, staffIndex) => currentPartTop + staffIndex * options.staffGap);
    const top = staffTops[0] ?? currentPartTop;
    const bottom = (staffTops[staffTops.length - 1] ?? currentPartTop) + options.staffHeight;
    const staves = part.staves.map((staff, staffIndex) =>
      createRenderStaff(score, part.id, staff, staffTops[staffIndex], measures, options)
    );

    parts.push({
      part,
      name: part.name,
      top,
      bottom,
      staves
    });
    partTop = currentPartTop + partHeight(part.staves.length, options);
  }

  return parts;
}

function createRenderStaff(
  score: ScoreDraft,
  partId: string,
  staff: ScoreStaff,
  staffTop: number,
  measures: RenderMeasure[],
  options: RenderLayoutOptions
): RenderStaff {
  const events = measures.flatMap((measure) => createRenderEvents(partId, staff, staffTop, measure, options));
  const staffWithCollision = avoidStaffCollisions({
    partId,
    staff,
    staffTop,
    events,
    beams: [],
    tuplets: []
  });
  const beams = measures.flatMap((measure) =>
    createBeamGroups(
      staffWithCollision.events.filter((event) => event.measure.measure.index === measure.measure.index),
      measure.measure,
      score.ppq,
      staff,
      staffTop,
      options
    )
  );
  const beamedIds = new Set(beams.flatMap((beam) => beam.eventIds));

  return {
    ...staffWithCollision,
    events: staffWithCollision.events.map((event) => ({
      ...event,
      beamed: beamedIds.has(event.event.id)
    })),
    beams,
    tuplets: createRenderTuplets(score, partId, staff.index, staffWithCollision.events, staffTop)
  };
}

function createRenderTuplets(
  score: ScoreDraft,
  partId: string,
  staffIndex: number,
  events: RenderEvent[],
  staffTop: number
): RenderTuplet[] {
  const result: RenderTuplet[] = [];
  const eventsByTuplet = new Map<string, RenderEvent[]>();

  for (const event of events) {
    if (event.event.kind === "chord" && event.event.tupletId) {
      eventsByTuplet.set(event.event.tupletId, [...(eventsByTuplet.get(event.event.tupletId) ?? []), event]);
    }
  }

  for (const tuplet of score.tuplets.filter((item) => item.partId === partId && item.staffIndex === staffIndex)) {
    const tupletEvents = (eventsByTuplet.get(tuplet.id) ?? []).sort((a, b) => a.x - b.x);
    if (tupletEvents.length < 2) {
      continue;
    }

    const direction = tupletEvents.some((event) => event.stemDirection === "down") ? "down" : "up";
    const yValues = tupletEvents.flatMap((event) => event.notes.map((note) => note.y));
    const x1 = tupletEvents[0].x - 10;
    const x2 = tupletEvents[tupletEvents.length - 1].x + 10;
    const y = direction === "up"
      ? Math.min(...yValues, staffTop) - 54
      : Math.max(...yValues, staffTop + 40) + 54;

    result.push({
      id: tuplet.id,
      eventIds: tupletEvents.map((event) => event.event.id),
      label: String(tuplet.actualNotes),
      x1,
      x2,
      y,
      bracketY: y + (direction === "up" ? 7 : -7),
      direction
    });
  }

  return result;
}

function createRenderEvents(
  partId: string,
  staff: ScoreStaff,
  staffTop: number,
  measure: RenderMeasure,
  options: RenderLayoutOptions
): RenderEvent[] {
  return staff.events
    .filter(
      (event) =>
        event.partId === partId &&
        event.staffIndex === staff.index &&
        event.measureIndex === measure.measure.index &&
        (event.kind === "chord" || event.voiceIndex === 0)
    )
    .map((event) => createRenderEvent(event, staff, staffTop, measure, options));
}

function createRenderEvent(
  event: ScoreEvent,
  staff: ScoreStaff,
  staffTop: number,
  measure: RenderMeasure,
  options: RenderLayoutOptions
): RenderEvent {
  const x = xForEvent(event, measure, options);

  if (event.kind === "rest") {
    const restY = staffTop + options.lineGap * 2.8;
    const glyphBoxes = restGlyphBoxes(x, restY, event.dots);
    return {
      event,
      measure,
      x,
      box: unionBoxes(glyphBoxes),
      glyphBoxes,
      beamed: false,
      notes: [],
      restY
    };
  }

  const notes = event.notes.map((note) => ({
    ...createRenderNote(note, staff, staffTop, options),
    accidentalX: x - 24
  }));
  const highestY = Math.min(...notes.map((note) => note.y));
  const lowestY = Math.max(...notes.map((note) => note.y));
  const stemDirection = stemDirectionForChord(event, staff, staffTop, highestY, lowestY, options.lineGap);
  applySecondChordOffsets(notes, x, stemDirection, options.lineGap);
  const glyphBoxes = chordGlyphBoxes(event, notes, x, stemDirection, options);

  return {
    event,
    measure,
    x,
    box: unionBoxes(glyphBoxes),
    glyphBoxes,
    stemDirection,
    beamed: false,
    notes,
    restY: staffTop + options.lineGap * 2.8
  };
}

function createRenderNote(
  note: ScoreChord["notes"][number],
  staff: ScoreStaff,
  staffTop: number,
  options: RenderLayoutOptions
): RenderNote {
  const y = staffYForPitch(note, staff.clef, staffTop, options.lineGap);

  return {
    note,
    y,
    noteHeadX: 0,
    accidentalX: 0,
    ledgerLines: ledgerLinesForY(y, staffTop, options)
  };
}

function applySecondChordOffsets(
  notes: RenderNote[],
  x: number,
  stemDirection: "up" | "down",
  lineGap: number
) {
  for (const note of notes) {
    note.noteHeadX = x;
  }

  const sorted = [...notes].sort((a, b) => b.y - a.y);
  const offset = stemDirection === "up" ? -10 : 10;
  let alternate = false;

  for (let index = 1; index < sorted.length; index += 1) {
    const close = Math.abs(sorted[index].y - sorted[index - 1].y) <= lineGap / 2 + 0.5;
    if (!close) {
      alternate = false;
      continue;
    }

    alternate = !alternate;
    sorted[index].noteHeadX = x + (alternate ? offset : 0);
  }
}

function restGlyphBoxes(x: number, restY: number, dots: number): RenderGlyphBox[] {
  const boxes: RenderGlyphBox[] = [
    { layer: "rest", x: x - 8, y: restY - 18, width: 18, height: 22 }
  ];

  for (let index = 0; index < dots; index += 1) {
    boxes.push({ layer: "rest", x: x + 12 + index * 7, y: restY - 11, width: 5, height: 5 });
  }

  return boxes;
}

function chordGlyphBoxes(
  event: ScoreChord,
  notes: RenderNote[],
  x: number,
  stemDirection: "up" | "down",
  options: RenderLayoutOptions
): RenderGlyphBox[] {
  const boxes: RenderGlyphBox[] = [];
  const highestY = Math.min(...notes.map((note) => note.y));
  const lowestY = Math.max(...notes.map((note) => note.y));

  for (const note of notes) {
    boxes.push({ layer: "notehead", x: note.noteHeadX - 9, y: note.y - 7, width: 18, height: 14 });
    if (note.note.alter !== 0) {
      boxes.push({ layer: "accidental", x: note.accidentalX - 7, y: note.y - 13, width: 14, height: 18 });
    }
  }

  for (let index = 0; index < event.dots; index += 1) {
    boxes.push({ layer: "notehead", x: x + 14 + index * 7, y: highestY - 3, width: 5, height: 5 });
  }

  if (event.tieStart) {
    boxes.push({ layer: "tie", x: x - 5, y: lowestY + 10, width: 105, height: 24 });
  }

  boxes.push({
    layer: "notehead",
    x: stemDirection === "up" ? x + 6 : x - 8,
    y: stemDirection === "up" ? highestY - options.stemLength : lowestY,
    width: 3,
    height: options.stemLength
  });

  return boxes;
}

function unionBoxes(boxes: RenderGlyphBox[]): RenderBox {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

function ledgerLinesForY(y: number, staffTop: number, options: RenderLayoutOptions): number[] {
  const lines: number[] = [];
  const topLine = staffTop;
  const bottomLine = staffTop + options.lineGap * 4;

  for (let lineY = bottomLine + options.lineGap; lineY <= y + 1; lineY += options.lineGap) {
    lines.push(lineY);
  }
  for (let lineY = topLine - options.lineGap; lineY >= y - 1; lineY -= options.lineGap) {
    lines.push(lineY);
  }

  return lines;
}
