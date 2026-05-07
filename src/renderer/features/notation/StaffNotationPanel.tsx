import { useMemo } from "react";
import type { ScoreChord, ScoreDraft, ScoreEvent, ScoreMeasure, ScoreStaff } from "../../lib/score";
import { accidentalText, staffYForPitch } from "../../lib/score/pitchSpelling";
import {
  buildPlaybackMap,
  findActiveScorePosition,
  findSeekPositionForElement,
  type PlaybackMapEntry
} from "../../lib/playbackMap";

type StaffNotationPanelProps = {
  score: ScoreDraft | null;
  positionMs: number;
  onSeek: (positionMs: number) => void;
};

const VIEWBOX_WIDTH = 1120;
const PAGE_PADDING = 28;
const MEASURES_PER_SYSTEM = 4;
const MEASURE_WIDTH = (VIEWBOX_WIDTH - PAGE_PADDING * 2) / MEASURES_PER_SYSTEM;
const LINE_GAP = 10;
const STAFF_GAP = 92;
const SYSTEM_GAP = 38;

export function StaffNotationPanel({
  score,
  positionMs,
  onSeek
}: StaffNotationPanelProps) {
  const playbackMap = useMemo(() => (score ? buildPlaybackMap(score) : []), [score]);
  const activePosition = useMemo(
    () => findActiveScorePosition(playbackMap, positionMs),
    [playbackMap, positionMs]
  );

  if (!score) {
    return (
      <div className="empty-state">
        <strong>打开一个 MIDI 文件</strong>
        <span>支持 .mid 和 .midi</span>
      </div>
    );
  }

  const systems = createSystems(score);
  const viewBoxHeight = systems.length
    ? systems[systems.length - 1].y + systems[systems.length - 1].height + PAGE_PADDING
    : 360;

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
        viewBox={`0 0 ${VIEWBOX_WIDTH} ${viewBoxHeight}`}
        role="img"
        aria-label={`${score.title} 五线谱`}
        onClick={handleScoreClick}
      >
        <title>{score.title}</title>
        {systems.map((system) => (
          <StaffSystemSvg
            key={system.index}
            activeIds={activePosition.activeIds}
            playbackMap={playbackMap}
            score={score}
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

type RenderSystem = {
  index: number;
  y: number;
  height: number;
  measures: ScoreMeasure[];
};

function createSystems(score: ScoreDraft): RenderSystem[] {
  const systems: RenderSystem[] = [];
  const partStaffCount = score.parts.reduce((count, part) => count + part.staves.length, 0);
  const systemHeight = Math.max(120, partStaffCount * STAFF_GAP + 36);

  for (let index = 0; index < score.measures.length; index += MEASURES_PER_SYSTEM) {
    systems.push({
      index: systems.length,
      y: PAGE_PADDING + systems.length * (systemHeight + SYSTEM_GAP),
      height: systemHeight,
      measures: score.measures.slice(index, index + MEASURES_PER_SYSTEM)
    });
  }

  return systems;
}

type StaffSystemSvgProps = {
  score: ScoreDraft;
  system: RenderSystem;
  activeIds: Set<string>;
  playbackMap: PlaybackMapEntry[];
};

function StaffSystemSvg({ score, system, activeIds, playbackMap }: StaffSystemSvgProps) {
  let staffOrdinal = 0;

  return (
    <g className="staff-system">
      {score.parts.map((part) =>
        part.staves.map((staff) => {
          const staffTop = system.y + staffOrdinal++ * STAFF_GAP + 22;
          return (
            <g key={`${system.index}-${part.id}-${staff.index}`}>
              <text className="staff-part-name" x={PAGE_PADDING - 8} y={staffTop + LINE_GAP * 2}>
                {system.index === 0 ? part.name : ""}
              </text>
              <StaffLines y={staffTop} />
              {system.measures.map((measure, measureOffset) => (
                <MeasureSvg
                  key={`${part.id}-${staff.index}-${measure.id}`}
                  activeIds={activeIds}
                  measure={measure}
                  measureOffset={measureOffset}
                  playbackMap={playbackMap}
                  staff={staff}
                  staffTop={staffTop}
                />
              ))}
            </g>
          );
        })
      )}
    </g>
  );
}

function StaffLines({ y }: { y: number }) {
  return (
    <g className="staff-lines">
      {Array.from({ length: 5 }).map((_, index) => (
        <line
          key={index}
          x1={PAGE_PADDING}
          x2={VIEWBOX_WIDTH - PAGE_PADDING}
          y1={y + index * LINE_GAP}
          y2={y + index * LINE_GAP}
        />
      ))}
    </g>
  );
}

type MeasureSvgProps = {
  measure: ScoreMeasure;
  measureOffset: number;
  staff: ScoreStaff;
  staffTop: number;
  activeIds: Set<string>;
  playbackMap: PlaybackMapEntry[];
};

function MeasureSvg({
  measure,
  measureOffset,
  staff,
  staffTop,
  activeIds,
  playbackMap
}: MeasureSvgProps) {
  const x = PAGE_PADDING + measureOffset * MEASURE_WIDTH;
  const events = staff.events.filter(
    (event) => event.measureIndex === measure.index && (event.kind === "chord" || event.voiceIndex === 0)
  );

  return (
    <g className="staff-measure">
      <line className="measure-bar" x1={x} x2={x} y1={staffTop} y2={staffTop + LINE_GAP * 4} />
      {measureOffset === 0 ? <ClefGlyph clef={staff.clef} x={x + 12} y={staffTop} /> : null}
      {measureOffset === 0 ? (
        <TimeSignatureGlyph
          numerator={measure.numerator}
          denominator={measure.denominator}
          x={x + 42}
          y={staffTop}
        />
      ) : null}
      {events.map((event) => (
        <ScoreEventSvg
          key={event.id}
          active={activeIds.has(event.id)}
          event={event}
          measure={measure}
          measureX={x}
          playbackMap={playbackMap}
          staff={staff}
          staffTop={staffTop}
        />
      ))}
      <line
        className="measure-bar"
        x1={x + MEASURE_WIDTH}
        x2={x + MEASURE_WIDTH}
        y1={staffTop}
        y2={staffTop + LINE_GAP * 4}
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

type ScoreEventSvgProps = {
  event: ScoreEvent;
  measure: ScoreMeasure;
  measureX: number;
  staff: ScoreStaff;
  staffTop: number;
  active: boolean;
  playbackMap: PlaybackMapEntry[];
};

function ScoreEventSvg({ event, measure, measureX, staff, staffTop, active }: ScoreEventSvgProps) {
  const x = xForEvent(event, measure, measureX);
  const className = `score-event ${event.kind}${active ? " active" : ""}`;

  if (event.kind === "rest") {
    return (
      <text className={className} x={x} y={staffTop + LINE_GAP * 2.8}>
        {restGlyph(event.durationName)}
      </text>
    );
  }

  return (
    <g className={className} data-score-element-id={event.id}>
      {event.notes.map((note) => {
        const y = staffYForPitch(note, staff.clef, staffTop, LINE_GAP);
        return (
          <g key={`${event.id}-${note.sourceNoteId}`}>
            <LedgerLines x={x} y={y} staffTop={staffTop} />
            {note.alter ? (
              <text className="accidental" x={x - 24} y={y + 4}>
                {accidentalText(note.alter)}
              </text>
            ) : null}
            <ellipse className="note-head" cx={x} cy={y} rx="8.5" ry="6" transform={`rotate(-18 ${x} ${y})`} />
          </g>
        );
      })}
      {event.durationName !== "whole" ? (
        <Stem event={event} staff={staff} staffTop={staffTop} x={x} />
      ) : null}
      {event.dots ? <circle className="duration-dot" cx={x + 16} cy={highestY(event, staff, staffTop)} r="2.2" /> : null}
      {event.tieStart ? <path className="tie-mark" d={`M ${x - 5} ${lowestY(event, staff, staffTop) + 14} C ${x + 28} ${lowestY(event, staff, staffTop) + 28}, ${x + 68} ${lowestY(event, staff, staffTop) + 28}, ${x + 100} ${lowestY(event, staff, staffTop) + 14}`} /> : null}
    </g>
  );
}

function Stem({
  event,
  staff,
  staffTop,
  x
}: {
  event: ScoreChord;
  staff: ScoreStaff;
  staffTop: number;
  x: number;
}) {
  if (event.voiceIndex === 1) {
    const y = lowestY(event, staff, staffTop);
    return <line className="note-stem" x1={x - 7} x2={x - 7} y1={y + 2} y2={y + 42} />;
  }

  const y = highestY(event, staff, staffTop);
  return <line className="note-stem" x1={x + 7} x2={x + 7} y1={y - 2} y2={y - 42} />;
}

function xForEvent(event: ScoreEvent, measure: ScoreMeasure, measureX: number): number {
  const measureTicks = Math.max(1, measure.endTicks - measure.startTicks);
  const localRatio = (event.startTicks - measure.startTicks) / measureTicks;
  return measureX + 72 + localRatio * Math.max(48, MEASURE_WIDTH - 96);
}

function highestY(event: ScoreChord, staff: ScoreStaff, staffTop: number): number {
  return Math.min(...event.notes.map((note) => staffYForPitch(note, staff.clef, staffTop, LINE_GAP)));
}

function lowestY(event: ScoreChord, staff: ScoreStaff, staffTop: number): number {
  return Math.max(...event.notes.map((note) => staffYForPitch(note, staff.clef, staffTop, LINE_GAP)));
}

function LedgerLines({ x, y, staffTop }: { x: number; y: number; staffTop: number }) {
  const lines: number[] = [];
  const topLine = staffTop;
  const bottomLine = staffTop + LINE_GAP * 4;

  for (let lineY = bottomLine + LINE_GAP; lineY <= y + 1; lineY += LINE_GAP) {
    lines.push(lineY);
  }
  for (let lineY = topLine - LINE_GAP; lineY >= y - 1; lineY -= LINE_GAP) {
    lines.push(lineY);
  }

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
