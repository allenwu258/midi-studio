import type { ScoreEvent, ScoreStaff } from "../score";
import { accidentalText } from "../score/pitchSpelling";
import { beamCount } from "./beams";
import { DEFAULT_RENDER_LAYOUT_OPTIONS } from "./types";
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

const LINE_GAP = DEFAULT_RENDER_LAYOUT_OPTIONS.lineGap;

export function renderLegacyScoreBodyToSvg(renderScore: RenderScore): string {
  return renderScore.systems.map((system) => staffSystemMarkup(renderScore, system)).join("");
}

export function renderLegacyScoreSvgStyle(): string {
  return [
    ".staff-score{background:#fff;color:#1b2838;font-family:Arial,'Segoe UI Symbol','Bravura','Noto Music',sans-serif}",
    ".staff-lines line,.measure-bar,.ledger-line,.note-stem,.beam-line{stroke:#1b2838;stroke-linecap:round}",
    ".staff-lines line,.measure-bar{stroke-width:1.4}",
    ".ledger-line{stroke-width:1.5}",
    ".note-stem{stroke-width:2}",
    ".beam-line{stroke-width:6}",
    ".note-head{fill:#1b2838}",
    ".duration-dot{fill:#1b2838}",
    ".tie-mark,.tuplet-mark path,.grand-staff-brace{fill:none;stroke:#1b2838;stroke-width:1.6;stroke-linecap:round}",
    ".clef-glyph{font-size:36px}",
    ".time-signature text{font-size:22px;font-weight:700;text-anchor:middle}",
    ".staff-part-name{font-size:12px;font-weight:700;text-anchor:end;fill:#344054}",
    ".score-event text,.tuplet-mark text{fill:#1b2838}",
    ".score-event.rest text{font-size:18px}",
    ".accidental{font-size:18px;text-anchor:middle}",
    ".tuplet-mark text{font-size:12px;text-anchor:middle;font-weight:700}"
  ].join("");
}

function staffSystemMarkup(renderScore: RenderScore, system: RenderSystem): string {
  return `<g class="staff-system">${system.parts.map((part) => partSystemMarkup(renderScore, system, part)).join("")}</g>`;
}

function partSystemMarkup(renderScore: RenderScore, system: RenderSystem, part: RenderPart): string {
  const showName = system.index === 0;
  const partName = showName ? escapeHtml(part.name) : "";
  const name = `<text class="staff-part-name" x="${DEFAULT_RENDER_LAYOUT_OPTIONS.scoreLeft - 36}" y="${(part.top + part.bottom) / 2 + 4}">${partName}</text>`;
  const brace = part.staves.length > 1
    ? grandStaffBraceMarkup(DEFAULT_RENDER_LAYOUT_OPTIONS.scoreLeft - 28, part.top, part.bottom)
    : "";
  const barlines = partBarlinesMarkup(system.measures, part.top, part.bottom);
  const staves = part.staves.map((staff) => staffMarkup(renderScore, system, staff)).join("");

  return `<g class="score-part-system">${name}${brace}${barlines}${staves}</g>`;
}

function staffMarkup(renderScore: RenderScore, system: RenderSystem, staff: RenderStaff): string {
  const staffLines = staffLinesMarkup(DEFAULT_RENDER_LAYOUT_OPTIONS.scoreLeft, system.endX, staff.staffTop);
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
  return `<path class="grand-staff-brace" d="M ${x + 12} ${top} C ${x - 8} ${top + 4}, ${x - 8} ${middle - 15}, ${x + 6} ${middle - 4} C ${x + 10} ${middle - 1}, ${x + 10} ${middle + 1}, ${x + 6} ${middle + 4} C ${x - 8} ${middle + 15}, ${x - 8} ${bottom - 4}, ${x + 12} ${bottom}" />`;
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
    clefGlyphMarkup(staff.clef, measure.x + 12, staffTop),
    timeSignatureMarkup(measure.measure.numerator, measure.measure.denominator, measure.x + 42, staffTop),
    `</g>`
  ].join("");
}

function clefGlyphMarkup(clef: ScoreStaff["clef"], x: number, y: number): string {
  const label = clef === "bass" ? "&#x1D122;" : clef === "percussion" ? "&#x1D13D;" : "&#x1D11E;";
  return `<text class="clef-glyph" x="${x}" y="${y + LINE_GAP * 3.3}">${label}</text>`;
}

function timeSignatureMarkup(numerator: number, denominator: number, x: number, y: number): string {
  return `<g class="time-signature"><text x="${x}" y="${y + LINE_GAP * 1.7}">${numerator}</text><text x="${x}" y="${y + LINE_GAP * 3.25}">${denominator}</text></g>`;
}

function scoreEventMarkup(renderEvent: RenderEvent, staff: ScoreStaff): string {
  const { event, x } = renderEvent;
  const className = `score-event ${event.kind}`;

  if (event.kind === "rest") {
    return `<g class="${className}"><text x="${x}" y="${renderEvent.restY}">${restGlyph(event.durationName)}</text>${durationDotsMarkup(event.dots, x + 14, renderEvent.restY - 8)}</g>`;
  }

  const notes = renderEvent.notes.map((note) => [
    `<g>`,
    ledgerLinesMarkup(note.noteHeadX, note.ledgerLines),
    note.note.accidental !== undefined
      ? `<text class="accidental" x="${note.accidentalX}" y="${note.y + 4}">${escapeHtml(accidentalText(note.note.accidental))}</text>`
      : "",
    `<ellipse class="note-head" cx="${note.noteHeadX}" cy="${note.y}" rx="8.5" ry="6" transform="rotate(-18 ${note.noteHeadX} ${note.y})" />`,
    `</g>`
  ].join("")).join("");
  const stem = event.durationName !== "whole" && !renderEvent.beamed ? stemMarkup(renderEvent) : "";
  const dots = durationDotsMarkup(event.dots, x + 16, Math.min(...renderEvent.notes.map((note) => note.y)));
  const tie = event.tieStart ? tieMarkup(renderEvent) : "";

  return `<g class="${className}" data-score-element-id="${escapeAttribute(event.id)}">${notes}${stem}${dots}${tie}<title>${staff.clef}</title></g>`;
}

function durationDotsMarkup(count: ScoreEvent["dots"], x: number, y: number): string {
  if (!count) {
    return "";
  }

  return Array.from({ length: count }).map((_, index) =>
    `<circle class="duration-dot" cx="${x + index * 7}" cy="${y}" r="2.2" />`
  ).join("");
}

function stemMarkup(renderEvent: RenderEvent): string {
  const x = renderEvent.x;

  if (renderEvent.stemDirection === "down") {
    const y = Math.max(...renderEvent.notes.map((note) => note.y));
    return `<line class="note-stem" x1="${x - 7}" x2="${x - 7}" y1="${y + 2}" y2="${y + 42}" />`;
  }

  const y = Math.min(...renderEvent.notes.map((note) => note.y));
  return `<line class="note-stem" x1="${x + 7}" x2="${x + 7}" y1="${y - 2}" y2="${y - 42}" />`;
}

function tieMarkup(renderEvent: RenderEvent): string {
  const y = Math.max(...renderEvent.notes.map((note) => note.y));
  return `<path class="tie-mark" d="M ${renderEvent.x - 5} ${y + 14} C ${renderEvent.x + 28} ${y + 28}, ${renderEvent.x + 68} ${y + 28}, ${renderEvent.x + 100} ${y + 14}" />`;
}

function beamGroupMarkup(beam: RenderBeamGroup): string {
  const stems = beam.points.map((point) =>
    `<line class="note-stem" x1="${point.stemX}" x2="${point.stemX}" y1="${point.baseY}" y2="${point.beamY}" />`
  ).join("");
  const beams = Array.from({ length: beam.maxBeamCount }).map((_, beamIndex) =>
    beamSegments(beam.points, beamIndex + 1).map((segment) => {
      const offset = beam.direction === "up" ? beamIndex * 7 : -beamIndex * 7;
      return `<line class="beam-line" x1="${segment.x1}" x2="${segment.x2}" y1="${segment.y1 + offset}" y2="${segment.y2 + offset}" />`;
    }).join("")
  ).join("");

  return `<g class="beam-group">${stems}${beams}</g>`;
}

function tupletMarkup(tuplet: RenderTuplet): string {
  const hook = tuplet.direction === "up" ? 6 : -6;
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
        const partialLength = 18 * directionMultiplier;
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
    `<line class="ledger-line" x1="${x - 13}" x2="${x + 13}" y1="${lineY}" y2="${lineY}" />`
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
    case "32nd":
      return "&#x1D13F;";
    case "quarter":
    default:
      return "&#x1D13D;";
  }
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
