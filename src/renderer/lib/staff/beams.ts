import type { ScoreChord, ScoreDurationName, ScoreMeasure, ScoreStaff } from "../score";
import type { RenderBeamGroup, RenderBeamPoint, RenderEvent, RenderLayoutOptions, StemDirection } from "./types";

export function createBeamGroups(
  renderEvents: RenderEvent[],
  measure: ScoreMeasure,
  ppq: number,
  staff: ScoreStaff,
  staffTop: number,
  options: RenderLayoutOptions
): RenderBeamGroup[] {
  const chords = renderEvents
    .filter((renderEvent) => renderEvent.event.kind === "chord")
    .map((renderEvent) => renderEvent as RenderEvent & { event: ScoreChord });
  const groups: RenderBeamGroup[] = [];
  const voiceIndexes = [...new Set(chords.map((renderEvent) => renderEvent.event.voiceIndex))].sort((a, b) => a - b);

  for (const voiceIndex of voiceIndexes) {
    const voiceChords = chords
      .filter((renderEvent) => renderEvent.event.voiceIndex === voiceIndex)
      .sort((a, b) => a.event.startTicks - b.event.startTicks || a.event.endTicks - b.event.endTicks);
    let current: Array<RenderEvent & { event: ScoreChord }> = [];

    for (const renderEvent of voiceChords) {
      const chord = renderEvent.event;
      const beatIndex = Math.floor((chord.startTicks - measure.startTicks) / ppq);
      const currentBeatIndex = current.length
        ? Math.floor((current[0].event.startTicks - measure.startTicks) / ppq)
        : beatIndex;
      const previous = current[current.length - 1]?.event;
      const separatedByRest = previous ? chord.startTicks > previous.endTicks + ppq / 8 : false;

      if (!isBeamable(chord) || beatIndex !== currentBeatIndex || separatedByRest) {
        pushBeamGroup(groups, current, staff, staffTop, options);
        current = [];
      }

      if (isBeamable(chord)) {
        current.push(renderEvent);
      }
    }

    pushBeamGroup(groups, current, staff, staffTop, options);
  }

  return groups;
}

export function beamCount(durationName: ScoreDurationName): number {
  switch (durationName) {
    case "eighth":
      return 1;
    case "16th":
      return 2;
    case "32nd":
      return 3;
    default:
      return 0;
  }
}

export function stemDirectionForChord(
  event: ScoreChord,
  staff: ScoreStaff,
  staffTop: number,
  highestY: number,
  lowestY: number,
  lineGap: number
): StemDirection {
  if (staff.voiceCount > 1) {
    return event.voiceIndex === 1 ? "down" : "up";
  }

  const centerY = (highestY + lowestY) / 2;
  return centerY <= staffTop + lineGap * 2 ? "down" : "up";
}

function pushBeamGroup(
  groups: RenderBeamGroup[],
  events: Array<RenderEvent & { event: ScoreChord }>,
  staff: ScoreStaff,
  staffTop: number,
  options: RenderLayoutOptions
) {
  if (events.length < 2) {
    return;
  }

  const direction = stemDirectionForBeam(events, staff, staffTop, options);
  const points = createBeamPoints(events, direction, options);
  const maxBeamCount = Math.max(...events.map((renderEvent) => beamCount(renderEvent.event.durationName)));
  groups.push({
    id: `${events[0].event.id}-beam-${events[events.length - 1].event.id}`,
    eventIds: events.map((renderEvent) => renderEvent.event.id),
    direction,
    points,
    maxBeamCount
  });
}

function createBeamPoints(
  events: Array<RenderEvent & { event: ScoreChord }>,
  direction: StemDirection,
  options: RenderLayoutOptions
): RenderBeamPoint[] {
  const stems = events.map((renderEvent) => ({
    event: renderEvent.event,
    eventId: renderEvent.event.id,
    stemX: direction === "up" ? renderEvent.x + 7 : renderEvent.x - 7,
    baseY:
      direction === "up"
        ? Math.min(...renderEvent.notes.map((note) => note.y)) - 2
        : Math.max(...renderEvent.notes.map((note) => note.y)) + 2
  }));
  const first = stems[0];
  const last = stems[stems.length - 1];
  const anchorY =
    direction === "up"
      ? Math.min(...stems.map((stem) => stem.baseY)) - options.stemLength
      : Math.max(...stems.map((stem) => stem.baseY)) + options.stemLength;
  const slope = clamp((last.baseY - first.baseY) * 0.18, -7, 7);
  const startBeamY = anchorY - slope / 2;
  const endBeamY = anchorY + slope / 2;

  return stems.map((stem) => ({
    ...stem,
    beamY: lineYAt(stem.stemX, first.stemX, last.stemX, startBeamY, endBeamY)
  }));
}

function stemDirectionForBeam(
  events: Array<RenderEvent & { event: ScoreChord }>,
  staff: ScoreStaff,
  staffTop: number,
  options: RenderLayoutOptions
): StemDirection {
  if (staff.voiceCount > 1) {
    return events[0]?.event.voiceIndex === 1 ? "down" : "up";
  }

  const averageY =
    events.reduce((sum, renderEvent) => {
      const highestY = Math.min(...renderEvent.notes.map((note) => note.y));
      const lowestY = Math.max(...renderEvent.notes.map((note) => note.y));
      return sum + (highestY + lowestY) / 2;
    }, 0) / Math.max(1, events.length);
  return averageY <= staffTop + options.lineGap * 2 ? "down" : "up";
}

function isBeamable(event: ScoreChord): boolean {
  return beamCount(event.durationName) > 0 && event.dots === 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lineYAt(x: number, x1: number, x2: number, y1: number, y2: number): number {
  if (x1 === x2) {
    return y1;
  }
  return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
}
