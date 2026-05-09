import type { ScoreEvent, ScoreStaff } from "../score";
import { beamCount } from "./beams";
import { ENGRAVED_RENDER_LAYOUT_OPTIONS } from "./types";
import type {
  RenderBeamGroup,
  RenderBeamPoint,
  RenderEvent,
  RenderMeasure,
  RenderPart,
  RenderScore,
  RenderStaff,
  RenderSystem,
  RenderTuplet
} from "./types";

const LINE_GAP = ENGRAVED_RENDER_LAYOUT_OPTIONS.lineGap;

export function renderScoreBodyToSvg(renderScore: RenderScore): string {
  return renderScore.systems.map((system) => staffSystemMarkup(renderScore, system)).join("");
}

export function renderScoreSvgStyle(): string {
  return [
    ".staff-score{background:#fff;color:#19222f;font-family:Inter,'Segoe UI','Microsoft YaHei',Arial,sans-serif}",
    ".score-page-background{fill:#fffdf8}",
    ".music-glyph{font-family:'Bravura','Noto Music','Segoe UI Symbol','Apple Symbols',serif;dominant-baseline:alphabetic}",
    ".staff-lines line,.measure-bar,.ledger-line,.note-stem{stroke:#182433;stroke-linecap:round;vector-effect:non-scaling-stroke}",
    ".staff-lines line{stroke-width:1.15}",
    ".measure-bar{stroke:#445264;stroke-width:1.05}",
    ".part-barlines .measure-bar{stroke:#182433;stroke-width:1.18}",
    ".ledger-line{stroke-width:1.22}",
    ".note-stem{stroke-width:1.45}",
    ".beam-line{fill:none;stroke:#182433;stroke-linecap:butt;stroke-width:5.1;vector-effect:non-scaling-stroke}",
    ".note-head{fill:#182433;stroke:#182433;stroke-width:.65;vector-effect:non-scaling-stroke}",
    ".duration-dot{fill:#182433}",
    ".grand-staff-brace{fill:none;stroke:#182433;stroke-linecap:round;stroke-width:1.85;vector-effect:non-scaling-stroke}",
    ".staff-part-name{fill:#526071;font-size:12px;font-weight:750;text-anchor:end}",
    ".clef-glyph{fill:#182433;font-size:40px}",
    ".time-signature text{fill:#182433;font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:800;text-anchor:middle}",
    ".accidental{fill:#182433;font-size:21px;text-anchor:middle}",
    ".rest-glyph{fill:#566274;font-size:23px;text-anchor:middle}",
    ".score-event.chord{cursor:pointer}",
    ".tie-mark,.tuplet-mark path{fill:none;stroke:#4d5a6b;stroke-linecap:round;vector-effect:non-scaling-stroke}",
    ".tie-mark{stroke-width:1.25}",
    ".tuplet-mark path{stroke-width:1.15}",
    ".tuplet-mark text{fill:#4d5a6b;font-family:Georgia,'Times New Roman',serif;font-size:12px;font-weight:800;text-anchor:middle}",
    ".active-score-overlay{pointer-events:none}",
    ".active-score-overlay .note-head{fill:#087c73;stroke:#065f57}",
    ".active-score-overlay .note-stem,.active-score-overlay .beam-line,.active-score-overlay .tie-mark,.active-score-overlay .tuplet-mark path{stroke:#087c73}",
    ".active-score-overlay .tuplet-mark text{fill:#087c73}"
  ].join("");
}

export function noteheadGlyphMarkup(x: number, y: number, className = "note-head"): string {
  return `<path class="${className}" d="${noteheadPathD(x, y)}" />`;
}

function staffSystemMarkup(renderScore: RenderScore, system: RenderSystem): string {
  return `<g class="staff-system">${system.parts.map((part) => partSystemMarkup(renderScore, system, part)).join("")}</g>`;
}

function partSystemMarkup(renderScore: RenderScore, system: RenderSystem, part: RenderPart): string {
  const showName = system.index === 0;
  const partName = showName ? escapeHtml(part.name) : "";
  const name = `<text class="staff-part-name" x="${ENGRAVED_RENDER_LAYOUT_OPTIONS.scoreLeft - 38}" y="${(part.top + part.bottom) / 2 + 4}">${partName}</text>`;
  const brace = part.staves.length > 1
    ? grandStaffBraceMarkup(ENGRAVED_RENDER_LAYOUT_OPTIONS.scoreLeft - 31, part.top, part.bottom)
    : "";
  const barlines = partBarlinesMarkup(system.measures, part.top, part.bottom);
  const staves = part.staves.map((staff) => staffMarkup(renderScore, system, staff)).join("");

  return `<g class="score-part-system">${name}${brace}${barlines}${staves}</g>`;
}

function staffMarkup(renderScore: RenderScore, system: RenderSystem, staff: RenderStaff): string {
  const staffLines = staffLinesMarkup(ENGRAVED_RENDER_LAYOUT_OPTIONS.scoreLeft, system.endX, staff.staffTop);
  const attributes = system.measures.map((measure) => measureAttributesMarkup(measure, staff.staff, staff.staffTop)).join("");
  const events = staff.events.map((event) => scoreEventMarkup(event, staff.staff)).join("");
  const beams = staff.beams.map(beamGroupMarkup).join("");
  const tuplets = staff.tuplets.map(tupletMarkup).join("");

  return `<g>${staffLines}${attributes}${events}${beams}${tuplets}<title>${escapeHtml(renderScore.score.title)}</title></g>`;
}

function staffLinesMarkup(x1: number, x2: number, y: number): string {
  return `<g class="staff-lines">${Array.from({ length: 5 }).map((_, index) =>
    `<line x1="${x1}" x2="${x2}" y1="${y + index * LINE_GAP}" y2="${y + index * LINE_GAP}" />`
  ).join("")}</g>`;
}

function grandStaffBraceMarkup(x: number, top: number, bottom: number): string {
  const middle = (top + bottom) / 2;
  return `<path class="grand-staff-brace" d="M ${x + 13} ${top - 1} C ${x - 9} ${top + 5}, ${x - 7} ${middle - 17}, ${x + 6} ${middle - 5} C ${x + 10} ${middle - 1}, ${x + 10} ${middle + 1}, ${x + 6} ${middle + 5} C ${x - 7} ${middle + 17}, ${x - 9} ${bottom - 5}, ${x + 13} ${bottom + 1}" />`;
}

function partBarlinesMarkup(measures: RenderMeasure[], top: number, bottom: number): string {
  const edges = measures.length ? [measures[0].x, ...measures.map((measure) => measure.x + measure.width)] : [];
  return `<g class="part-barlines">${edges.map((x) =>
    `<line class="measure-bar" x1="${x}" x2="${x}" y1="${top}" y2="${bottom}" />`
  ).join("")}</g>`;
}

function measureAttributesMarkup(measure: RenderMeasure, staff: ScoreStaff, staffTop: number): string {
  if (measure.offset !== 0) {
    return "";
  }

  return [
    `<g class="staff-measure">`,
    clefGlyphMarkup(staff.clef, measure.x + 13, staffTop),
    timeSignatureMarkup(measure.measure.numerator, measure.measure.denominator, measure.x + 48, staffTop),
    `</g>`
  ].join("");
}

function clefGlyphMarkup(clef: ScoreStaff["clef"], x: number, y: number): string {
  const label = clef === "bass" ? "&#x1D122;" : clef === "percussion" ? "&#x1D13D;" : "&#x1D11E;";
  return `<text class="music-glyph clef-glyph" x="${x}" y="${y + LINE_GAP * 3.35}">${label}</text>`;
}

function timeSignatureMarkup(numerator: number, denominator: number, x: number, y: number): string {
  return `<g class="time-signature"><text x="${x}" y="${y + LINE_GAP * 1.62}">${numerator}</text><text x="${x}" y="${y + LINE_GAP * 3.18}">${denominator}</text></g>`;
}

function scoreEventMarkup(renderEvent: RenderEvent, staff: ScoreStaff): string {
  const { event, x } = renderEvent;
  const className = `score-event ${event.kind}`;

  if (event.kind === "rest") {
    return `<g class="${className}"><text class="music-glyph rest-glyph" x="${x}" y="${renderEvent.restY}">${restGlyph(event.durationName)}</text>${durationDotsMarkup(event.dots, x + 14, renderEvent.restY - 8)}</g>`;
  }

  const notes = renderEvent.notes.map((note) => [
    `<g>`,
    ledgerLinesMarkup(note.noteHeadX, note.ledgerLines),
    note.note.accidental !== undefined
      ? `<text class="music-glyph accidental" x="${note.accidentalX}" y="${note.y + 5}">${accidentalGlyph(note.note.accidental)}</text>`
      : "",
    noteheadGlyphMarkup(note.noteHeadX, note.y),
    `</g>`
  ].join("")).join("");
  const stem = event.durationName !== "whole" && !renderEvent.beamed ? stemMarkup(renderEvent) : "";
  const dots = durationDotsMarkup(event.dots, x + 16, dotY(renderEvent));
  const tie = event.tieStart ? tieMarkup(renderEvent) : "";

  return `<g class="${className}" data-score-element-id="${escapeAttribute(event.id)}">${notes}${stem}${dots}${tie}<title>${staff.clef}</title></g>`;
}

function durationDotsMarkup(count: ScoreEvent["dots"], x: number, y: number): string {
  if (!count) {
    return "";
  }

  return Array.from({ length: count }).map((_, index) =>
    `<circle class="duration-dot" cx="${x + index * 6.8}" cy="${y}" r="1.85" />`
  ).join("");
}

function dotY(renderEvent: RenderEvent): number {
  return Math.min(...renderEvent.notes.map((note) => note.y));
}

function stemMarkup(renderEvent: RenderEvent): string {
  const x = renderEvent.x;

  if (renderEvent.stemDirection === "down") {
    const y = Math.max(...renderEvent.notes.map((note) => note.y));
    return `<line class="note-stem" x1="${x - 7}" x2="${x - 7}" y1="${y + 2}" y2="${y + 39}" />`;
  }

  const y = Math.min(...renderEvent.notes.map((note) => note.y));
  return `<line class="note-stem" x1="${x + 7}" x2="${x + 7}" y1="${y - 2}" y2="${y - 39}" />`;
}

function tieMarkup(renderEvent: RenderEvent): string {
  const y = Math.max(...renderEvent.notes.map((note) => note.y));
  const x1 = renderEvent.x - 7;
  const x2 = renderEvent.x + 96;
  const controlY = y + 25;
  return `<path class="tie-mark" d="M ${x1} ${y + 12} C ${x1 + 28} ${controlY}, ${x2 - 28} ${controlY}, ${x2} ${y + 12}" />`;
}

function beamGroupMarkup(beam: RenderBeamGroup): string {
  const stems = beam.points.map((point) =>
    `<line class="note-stem" x1="${point.stemX}" x2="${point.stemX}" y1="${point.baseY}" y2="${point.beamY}" />`
  ).join("");
  const beams = Array.from({ length: beam.maxBeamCount }).map((_, beamIndex) =>
    beamSegments(beam.points, beamIndex + 1).map((segment) => {
      const offset = beam.direction === "up" ? beamIndex * 6.5 : -beamIndex * 6.5;
      return `<line class="beam-line" x1="${segment.x1}" x2="${segment.x2}" y1="${segment.y1 + offset}" y2="${segment.y2 + offset}" />`;
    }).join("")
  ).join("");

  return `<g class="beam-group">${stems}${beams}</g>`;
}

function tupletMarkup(tuplet: RenderTuplet): string {
  const hook = tuplet.direction === "up" ? 5 : -5;
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

function ledgerLinesMarkup(x: number, lines: number[]): string {
  return lines.map((lineY) =>
    `<line class="ledger-line" x1="${x - 12}" x2="${x + 12}" y1="${lineY}" y2="${lineY}" />`
  ).join("");
}

function restGlyph(durationName: ScoreEvent["durationName"]): string {
  switch (durationName) {
    case "whole":
      return "&#x1D13B;";
    case "half":
      return "&#x1D13C;";
    case "eighth":
      return "&#x1D13E;";
    case "16th":
      return "&#x1D13F;";
    case "32nd":
      return "&#x1D140;";
    case "quarter":
    default:
      return "&#x1D13D;";
  }
}

function accidentalGlyph(alter: number): string {
  switch (alter) {
    case -2:
      return "&#x1D12B;";
    case -1:
      return "&#x266D;";
    case 0:
      return "&#x266E;";
    case 2:
      return "&#x1D12A;";
    case 1:
    default:
      return "&#x266F;";
  }
}

function noteheadPathD(x: number, y: number): string {
  return [
    `M ${x - 8.5} ${y + 1.7}`,
    `C ${x - 8.1} ${y - 3.2}, ${x - 2.3} ${y - 7.2}, ${x + 4.3} ${y - 6.1}`,
    `C ${x + 9.2} ${y - 5.2}, ${x + 9.5} ${y - 0.8}, ${x + 6.9} ${y + 2.8}`,
    `C ${x + 3.3} ${y + 7.7}, ${x - 3.8} ${y + 8.3}, ${x - 7.3} ${y + 4.6}`,
    `C ${x - 8.2} ${y + 3.7}, ${x - 8.6} ${y + 2.7}, ${x - 8.5} ${y + 1.7}`,
    "Z"
  ].join(" ");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
