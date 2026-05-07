import { useMemo } from "react";
import type { ScoreDraft, ScoreEvent, ScoreStaff } from "../../lib/score";
import { accidentalText } from "../../lib/score/pitchSpelling";
import {
  DEFAULT_RENDER_LAYOUT_OPTIONS,
  layoutScore,
  type RenderBeamGroup,
  type RenderBeamPoint,
  type RenderEvent,
  type RenderMeasure,
  type RenderPart,
  type RenderScore,
  type RenderStaff,
  type RenderSystem,
  type RenderTuplet
} from "../../lib/staff";
import {
  buildPlaybackMap,
  findActiveScorePosition,
  findSeekPositionForElement
} from "../../lib/playbackMap";

type StaffNotationPanelProps = {
  score: ScoreDraft | null;
  positionMs: number;
  onSeek: (positionMs: number) => void;
};

const LINE_GAP = DEFAULT_RENDER_LAYOUT_OPTIONS.lineGap;

export function StaffNotationPanel({
  score,
  positionMs,
  onSeek
}: StaffNotationPanelProps) {
  const playbackMap = useMemo(() => (score ? buildPlaybackMap(score) : []), [score]);
  const renderScore = useMemo(() => (score ? layoutScore(score) : null), [score]);
  const activePosition = useMemo(
    () => findActiveScorePosition(playbackMap, positionMs),
    [playbackMap, positionMs]
  );

  if (!score || !renderScore) {
    return (
      <div className="empty-state">
        <strong>打开一个 MIDI 文件</strong>
        <span>支持 .mid 和 .midi</span>
      </div>
    );
  }

  function handleScoreClick(event: React.MouseEvent<SVGSVGElement>) {
    const target = event.target instanceof Element
      ? event.target.closest("[data-score-element-id]")
      : null;
    const elementId = target?.getAttribute("data-score-element-id");
    if (!elementId) {
      return;
    }

    const seekPosition = findSeekPositionForElement(playbackMap, elementId);
    if (seekPosition !== null) {
      onSeek(seekPosition);
    }
  }

  return (
    <div className="staff-score-viewport">
      <svg
        className="staff-score"
        viewBox={`0 0 ${renderScore.width} ${renderScore.height}`}
        role="img"
        aria-label={`${score.title} 五线谱`}
        onClick={handleScoreClick}
      >
        <title>{score.title}</title>
        {renderScore.systems.map((system) => (
          <StaffSystemSvg
            key={system.index}
            activeIds={activePosition.activeIds}
            renderScore={renderScore}
            system={system}
          />
        ))}
      </svg>
      {score.diagnostics.length ? (
        <div className="score-diagnostics" aria-label="导入诊断">
          {score.diagnostics.map((diagnostic) => (
            <span key={`${diagnostic.code}-${diagnostic.trackIndex ?? "global"}-${diagnostic.tick ?? 0}`}>
              {diagnostic.message}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StaffSystemSvg({
  renderScore,
  system,
  activeIds
}: {
  renderScore: RenderScore;
  system: RenderSystem;
  activeIds: Set<string>;
}) {
  return (
    <g className="staff-system">
      {system.parts.map((part) => (
        <PartSystemSvg
          key={`${system.index}-${part.part.id}`}
          activeIds={activeIds}
          part={part}
          renderScore={renderScore}
          showName={system.index === 0}
          system={system}
        />
      ))}
    </g>
  );
}

function PartSystemSvg({
  activeIds,
  part,
  renderScore,
  showName,
  system
}: {
  activeIds: Set<string>;
  part: RenderPart;
  renderScore: RenderScore;
  showName: boolean;
  system: RenderSystem;
}) {
  return (
    <g className="score-part-system">
      <text className="staff-part-name" x={DEFAULT_RENDER_LAYOUT_OPTIONS.scoreLeft - 36} y={(part.top + part.bottom) / 2 + 4}>
        {showName ? part.name : ""}
      </text>
      {part.staves.length > 1 ? (
        <GrandStaffBrace
          x={DEFAULT_RENDER_LAYOUT_OPTIONS.scoreLeft - 28}
          top={part.top}
          bottom={part.bottom}
        />
      ) : null}
      <PartBarlines measures={system.measures} top={part.top} bottom={part.bottom} />
      {part.staves.map((staff) => (
        <StaffSvg
          key={`${part.part.id}-${staff.staff.index}`}
          activeIds={activeIds}
          renderScore={renderScore}
          staff={staff}
          system={system}
        />
      ))}
    </g>
  );
}

function StaffSvg({
  activeIds,
  renderScore,
  staff,
  system
}: {
  activeIds: Set<string>;
  renderScore: RenderScore;
  staff: RenderStaff;
  system: RenderSystem;
}) {
  return (
    <g>
      <StaffLines x1={DEFAULT_RENDER_LAYOUT_OPTIONS.scoreLeft} x2={system.endX} y={staff.staffTop} />
      {system.measures.map((measure) => (
        <MeasureAttributesSvg
          key={`${staff.partId}-${staff.staff.index}-${measure.measure.id}`}
          measure={measure}
          staff={staff.staff}
          staffTop={staff.staffTop}
        />
      ))}
      {staff.events.map((event) => (
        <ScoreEventSvg
          key={event.event.id}
          active={activeIds.has(event.event.id)}
          renderEvent={event}
          staff={staff.staff}
        />
      ))}
      {staff.beams.map((beam) => (
        <BeamGroupSvg
          key={beam.id}
          active={beam.eventIds.some((id) => activeIds.has(id))}
          beam={beam}
        />
      ))}
      {staff.tuplets.map((tuplet) => (
        <TupletSvg
          key={tuplet.id}
          active={tuplet.eventIds.some((id) => activeIds.has(id))}
          tuplet={tuplet}
        />
      ))}
      <title>{renderScore.score.title}</title>
    </g>
  );
}

function StaffLines({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  return (
    <g className="staff-lines">
      {Array.from({ length: 5 }).map((_, index) => (
        <line
          key={index}
          x1={x1}
          x2={x2}
          y1={y + index * LINE_GAP}
          y2={y + index * LINE_GAP}
        />
      ))}
    </g>
  );
}

function GrandStaffBrace({ x, top, bottom }: { x: number; top: number; bottom: number }) {
  const middle = (top + bottom) / 2;
  return (
    <path
      className="grand-staff-brace"
      d={`M ${x + 12} ${top} C ${x - 8} ${top + 4}, ${x - 8} ${middle - 15}, ${x + 6} ${middle - 4} C ${x + 10} ${middle - 1}, ${x + 10} ${middle + 1}, ${x + 6} ${middle + 4} C ${x - 8} ${middle + 15}, ${x - 8} ${bottom - 4}, ${x + 12} ${bottom}`}
    />
  );
}

function PartBarlines({ measures, top, bottom }: { measures: RenderMeasure[]; top: number; bottom: number }) {
  const edges = measures.length ? [measures[0].x, ...measures.map((measure) => measure.x + measure.width)] : [];

  return (
    <g className="part-barlines">
      {edges.map((x) => (
        <line key={x} className="measure-bar" x1={x} x2={x} y1={top} y2={bottom} />
      ))}
    </g>
  );
}

function MeasureAttributesSvg({
  measure,
  staff,
  staffTop
}: {
  measure: RenderMeasure;
  staff: ScoreStaff;
  staffTop: number;
}) {
  if (measure.offset !== 0) {
    return null;
  }

  return (
    <g className="staff-measure">
      <ClefGlyph clef={staff.clef} x={measure.x + 12} y={staffTop} />
      <TimeSignatureGlyph
        numerator={measure.measure.numerator}
        denominator={measure.measure.denominator}
        x={measure.x + 42}
        y={staffTop}
      />
    </g>
  );
}

function ClefGlyph({ clef, x, y }: { clef: ScoreStaff["clef"]; x: number; y: number }) {
  const label = clef === "bass" ? "𝄢" : clef === "percussion" ? "𝄽" : "𝄞";
  return (
    <text className="clef-glyph" x={x} y={y + LINE_GAP * 3.3}>
      {label}
    </text>
  );
}

function TimeSignatureGlyph({
  numerator,
  denominator,
  x,
  y
}: {
  numerator: number;
  denominator: number;
  x: number;
  y: number;
}) {
  return (
    <g className="time-signature">
      <text x={x} y={y + LINE_GAP * 1.7}>
        {numerator}
      </text>
      <text x={x} y={y + LINE_GAP * 3.25}>
        {denominator}
      </text>
    </g>
  );
}

function ScoreEventSvg({
  renderEvent,
  staff,
  active
}: {
  renderEvent: RenderEvent;
  staff: ScoreStaff;
  active: boolean;
}) {
  const { event, x } = renderEvent;
  const className = `score-event ${event.kind}${active ? " active" : ""}`;

  if (event.kind === "rest") {
    return (
      <text className={className} x={x} y={renderEvent.restY}>
        {restGlyph(event.durationName)}
      </text>
    );
  }

  return (
    <g className={className} data-score-element-id={event.id}>
      {renderEvent.notes.map((note) => (
        <g key={`${event.id}-${note.note.sourceNoteId}`}>
          <LedgerLines x={x} lines={note.ledgerLines} />
          {note.note.alter ? (
            <text className="accidental" x={note.accidentalX} y={note.y + 4}>
              {accidentalText(note.note.alter)}
            </text>
          ) : null}
          <ellipse className="note-head" cx={x} cy={note.y} rx="8.5" ry="6" transform={`rotate(-18 ${x} ${note.y})`} />
        </g>
      ))}
      {event.durationName !== "whole" && !renderEvent.beamed ? (
        <Stem renderEvent={renderEvent} />
      ) : null}
      {event.dots ? <circle className="duration-dot" cx={x + 16} cy={Math.min(...renderEvent.notes.map((note) => note.y))} r="2.2" /> : null}
      {event.tieStart ? (
        <path
          className="tie-mark"
          d={`M ${x - 5} ${Math.max(...renderEvent.notes.map((note) => note.y)) + 14} C ${x + 28} ${Math.max(...renderEvent.notes.map((note) => note.y)) + 28}, ${x + 68} ${Math.max(...renderEvent.notes.map((note) => note.y)) + 28}, ${x + 100} ${Math.max(...renderEvent.notes.map((note) => note.y)) + 14}`}
        />
      ) : null}
      <title>{staff.clef}</title>
    </g>
  );
}

function Stem({ renderEvent }: { renderEvent: RenderEvent }) {
  const x = renderEvent.x;

  if (renderEvent.stemDirection === "down") {
    const y = Math.max(...renderEvent.notes.map((note) => note.y));
    return <line className="note-stem" x1={x - 7} x2={x - 7} y1={y + 2} y2={y + 42} />;
  }

  const y = Math.min(...renderEvent.notes.map((note) => note.y));
  return <line className="note-stem" x1={x + 7} x2={x + 7} y1={y - 2} y2={y - 42} />;
}

function BeamGroupSvg({ beam, active }: { beam: RenderBeamGroup; active: boolean }) {
  return (
    <g className={`beam-group${active ? " active" : ""}`}>
      {beam.points.map((point) => (
        <line
          key={`${point.eventId}-stem`}
          className="note-stem"
          x1={point.stemX}
          x2={point.stemX}
          y1={point.baseY}
          y2={point.beamY}
        />
      ))}
      {Array.from({ length: beam.maxBeamCount }).map((_, beamIndex) => (
        <BeamLevelSvg
          key={beamIndex}
          beamIndex={beamIndex}
          direction={beam.direction}
          points={beam.points}
        />
      ))}
    </g>
  );
}

function TupletSvg({ tuplet, active }: { tuplet: RenderTuplet; active: boolean }) {
  const hook = tuplet.direction === "up" ? 6 : -6;
  return (
    <g className={`tuplet-mark${active ? " active" : ""}`}>
      <path
        d={`M ${tuplet.x1} ${tuplet.bracketY + hook} L ${tuplet.x1} ${tuplet.bracketY} L ${tuplet.x2} ${tuplet.bracketY} L ${tuplet.x2} ${tuplet.bracketY + hook}`}
      />
      <text x={(tuplet.x1 + tuplet.x2) / 2} y={tuplet.y}>
        {tuplet.label}
      </text>
    </g>
  );
}

function BeamLevelSvg({
  points,
  beamIndex,
  direction
}: {
  points: RenderBeamPoint[];
  beamIndex: number;
  direction: "up" | "down";
}) {
  const offset = direction === "up" ? beamIndex * 7 : -beamIndex * 7;
  const segments = beamSegments(points, beamIndex + 1);

  return (
    <>
      {segments.map((segment) => (
        <line
          key={`${beamIndex}-${segment.x1}-${segment.x2}`}
          className="beam-line"
          x1={segment.x1}
          x2={segment.x2}
          y1={segment.y1 + offset}
          y2={segment.y2 + offset}
        />
      ))}
    </>
  );
}

function beamSegments(points: RenderBeamPoint[], level: number): Array<{ x1: number; x2: number; y1: number; y2: number }> {
  const segments: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
  let startIndex: number | null = null;

  for (let index = 0; index <= points.length; index += 1) {
    const point = points[index];
    const hasBeam = point ? beamCountForEvent(point.event.durationName) >= level : false;

    if (hasBeam && startIndex === null) {
      startIndex = index;
    }

    if ((!hasBeam || index === points.length) && startIndex !== null) {
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
  }

  return segments;
}

function beamCountForEvent(durationName: ScoreEvent["durationName"]): number {
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

function LedgerLines({ x, lines }: { x: number; lines: number[] }) {
  return (
    <>
      {lines.map((lineY) => (
        <line key={lineY} className="ledger-line" x1={x - 13} x2={x + 13} y1={lineY} y2={lineY} />
      ))}
    </>
  );
}

function restGlyph(durationName: ScoreEvent["durationName"]): string {
  switch (durationName) {
    case "whole":
      return "𝄻";
    case "half":
      return "𝄼";
    case "eighth":
      return "𝄾";
    case "16th":
    case "32nd":
      return "𝄿";
    case "quarter":
    default:
      return "𝄽";
  }
}
