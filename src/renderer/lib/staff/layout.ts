import type { ScoreChord, ScoreDraft, ScoreEvent, ScoreStaff } from "../score";
import { staffYForPitch } from "../score/pitchSpelling";
import { createBeamGroups, stemDirectionForChord } from "./beams";
import { avoidStaffCollisions } from "./collisions";
import { createSystemMeasureLayouts, partHeight, xForEvent } from "./spacing";
import type {
  RenderBox,
  RenderEvent,
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

  for (let index = 0; index < score.measures.length; index += options.measuresPerSystem) {
    const measures = score.measures.slice(index, index + options.measuresPerSystem);
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
    return {
      event,
      measure,
      x,
      box: { x: x - 8, y: restY - 18, width: 18, height: 22 },
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
  const accidentalLeft = Math.min(x - 32, ...notes.filter((note) => note.note.alter !== 0).map((note) => note.accidentalX - 7));
  const boxLeft = Number.isFinite(accidentalLeft) ? accidentalLeft : x - 14;
  const boxTop = Math.min(highestY - 8, stemDirection === "up" ? highestY - options.stemLength : highestY - 8);
  const boxBottom = Math.max(lowestY + 8, stemDirection === "down" ? lowestY + options.stemLength : lowestY + 8);

  return {
    event,
    measure,
    x,
    box: { x: boxLeft, y: boxTop, width: x + 20 - boxLeft, height: boxBottom - boxTop },
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
    accidentalX: 0,
    ledgerLines: ledgerLinesForY(y, staffTop, options)
  };
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
