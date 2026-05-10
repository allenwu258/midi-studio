import type { NotationRendererMode } from "../../../shared/settings";
import { beamCount, type RenderBeamGroup, type RenderBeamPoint, type RenderEvent, type RenderTuplet } from "../../lib/staff";
import { noteheadGlyphMarkup } from "../../lib/staff/svgRenderer";
import type { ActiveRenderEvent } from "./activeEvents";
import type { PlaybackCursor } from "./playbackCursor";

export function renderActiveScoreOverlay(
  overlay: SVGGElement,
  activeEvents: ActiveRenderEvent[],
  cursor: PlaybackCursor | null,
  rendererMode: NotationRendererMode
): void {
  const beams = uniqueById(activeEvents.flatMap((activeEvent) => activeEvent.beams));
  const tuplets = uniqueById(activeEvents.flatMap((activeEvent) => activeEvent.tuplets));

  overlay.innerHTML = [
    playbackCursorMarkup(cursor),
    ...beams.map((beam) => activeBeamMarkup(beam, rendererMode)),
    ...tuplets.map((tuplet) => activeTupletMarkup(tuplet, rendererMode)),
    ...activeEvents.map((activeEvent) => activeEventMarkup(activeEvent.event, rendererMode))
  ].join("");
}

function activeEventMarkup(renderEvent: RenderEvent, rendererMode: NotationRendererMode): string {
  if (renderEvent.event.kind === "rest") {
    return "";
  }

  const noteHeads = renderEvent.notes
    .map((note) =>
      rendererMode === "engraved"
        ? noteheadGlyphMarkup(note.noteHeadX, note.y)
        : `<ellipse class="note-head" cx="${note.noteHeadX}" cy="${note.y}" rx="8.5" ry="6" transform="rotate(-18 ${note.noteHeadX} ${note.y})" />`
    )
    .join("");
  const stem = renderEvent.event.durationName !== "whole" && !renderEvent.beamed
    ? stemMarkup(renderEvent, rendererMode)
    : "";
  const tie = renderEvent.event.tieStart ? tieMarkup(renderEvent, rendererMode) : "";

  return `<g class="active-score-event">${noteHeads}${stem}${tie}</g>`;
}

function playbackCursorMarkup(cursor: PlaybackCursor | null): string {
  if (!cursor) {
    return "";
  }

  return [
    `<g class="playback-cursor">`,
    `<line class="playback-cursor-line" x1="${cursor.x}" y1="${cursor.y1}" x2="${cursor.x}" y2="${cursor.y2}" />`,
    `<circle class="playback-cursor-handle" cx="${cursor.x}" cy="${cursor.y1}" r="4.5" />`,
    `</g>`
  ].join("");
}

function stemMarkup(renderEvent: RenderEvent, rendererMode: NotationRendererMode): string {
  const x = renderEvent.x;
  const stemLength = rendererMode === "engraved" ? 39 : 42;

  if (renderEvent.stemDirection === "down") {
    const y = Math.max(...renderEvent.notes.map((note) => note.y));
    return `<line class="note-stem" x1="${x - 7}" x2="${x - 7}" y1="${y + 2}" y2="${y + stemLength}" />`;
  }

  const y = Math.min(...renderEvent.notes.map((note) => note.y));
  return `<line class="note-stem" x1="${x + 7}" x2="${x + 7}" y1="${y - 2}" y2="${y - stemLength}" />`;
}

function tieMarkup(renderEvent: RenderEvent, rendererMode: NotationRendererMode): string {
  const y = Math.max(...renderEvent.notes.map((note) => note.y));
  if (rendererMode === "classic") {
    return `<path class="tie-mark" d="M ${renderEvent.x - 5} ${y + 14} C ${renderEvent.x + 28} ${y + 28}, ${renderEvent.x + 68} ${y + 28}, ${renderEvent.x + 100} ${y + 14}" />`;
  }

  const x1 = renderEvent.x - 7;
  const x2 = renderEvent.x + 96;
  const controlY = y + 25;
  return `<path class="tie-mark" d="M ${x1} ${y + 12} C ${x1 + 28} ${controlY}, ${x2 - 28} ${controlY}, ${x2} ${y + 12}" />`;
}

function activeBeamMarkup(beam: RenderBeamGroup, rendererMode: NotationRendererMode): string {
  const stems = beam.points
    .map(
      (point) =>
        `<line class="note-stem" x1="${point.stemX}" x2="${point.stemX}" y1="${point.baseY}" y2="${point.beamY}" />`
    )
    .join("");
  const beams = Array.from({ length: beam.maxBeamCount })
    .map((_, beamIndex) =>
      beamSegments(beam.points, beamIndex + 1)
        .map((segment) => {
          const beamGap = rendererMode === "engraved" ? 6.5 : 7;
          const offset = beam.direction === "up" ? beamIndex * beamGap : -beamIndex * beamGap;
          return `<line class="beam-line" x1="${segment.x1}" x2="${segment.x2}" y1="${segment.y1 + offset}" y2="${segment.y2 + offset}" />`;
        })
        .join("")
    )
    .join("");

  return `<g class="beam-group">${stems}${beams}</g>`;
}

function activeTupletMarkup(tuplet: RenderTuplet, rendererMode: NotationRendererMode): string {
  const hookSize = rendererMode === "engraved" ? 5 : 6;
  const hook = tuplet.direction === "up" ? hookSize : -hookSize;

  return `<g class="tuplet-mark"><path d="M ${tuplet.x1} ${tuplet.bracketY + hook} L ${tuplet.x1} ${tuplet.bracketY} L ${tuplet.x2} ${tuplet.bracketY} L ${tuplet.x2} ${tuplet.bracketY + hook}" /><text x="${(tuplet.x1 + tuplet.x2) / 2}" y="${tuplet.y}">${tuplet.label}</text></g>`;
}

function beamSegments(points: RenderBeamPoint[], level: number): Array<{ x1: number; x2: number; y1: number; y2: number }> {
  const segments: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
  let startIndex: number | null = null;

  for (let index = 0; index <= points.length; index += 1) {
    const point = points[index];
    const hasBeam = point ? beamCount(point.event.durationName) >= level : false;
    const breaksSecondary = Boolean(point?.secondaryBreakBefore && level > 1);

    if (hasBeam && startIndex === null) {
      startIndex = index;
    }

    if ((!hasBeam || breaksSecondary || index === points.length) && startIndex !== null) {
      const endIndex = index - 1;

      if (endIndex > startIndex) {
        segments.push({
          x1: points[startIndex].stemX,
          x2: points[endIndex].stemX,
          y1: points[startIndex].beamY,
          y2: points[endIndex].beamY
        });
      } else if (level > 1) {
        const current = points[startIndex];
        const next = points[startIndex + 1] ?? points[startIndex - 1];
        const directionMultiplier = next && next.stemX < current.stemX ? -1 : 1;
        const partialLength = 17 * directionMultiplier;
        segments.push({
          x1: current.stemX,
          x2: current.stemX + partialLength,
          y1: current.beamY,
          y2: current.beamY
        });
      }

      startIndex = null;
    }

    if (hasBeam && breaksSecondary) {
      startIndex = index;
    }
  }

  return segments;
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const uniqueItems: T[] = [];

  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }

    seen.add(item.id);
    uniqueItems.push(item);
  }

  return uniqueItems;
}
