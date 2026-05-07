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
const SCORE_LEFT = 82;
const SCORE_RIGHT = 28;
const SYSTEM_WIDTH = VIEWBOX_WIDTH - SCORE_LEFT - SCORE_RIGHT;
const MEASURES_PER_SYSTEM = 4;
const MIN_MEASURE_WIDTH = 148;
const CLEF_TIME_WIDTH = 78;
const MEASURE_END_PADDING = 24;
const LINE_GAP = 10;
const STAFF_HEIGHT = LINE_GAP * 4;
const STAFF_GAP = 76;
const PART_GAP = 42;
const SYSTEM_TOP_PADDING = 26;
const SYSTEM_BOTTOM_PADDING = 24;
const SYSTEM_GAP = 34;
const STEM_LENGTH = 42;

type StemDirection = "up" | "down";

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
  measures: RenderMeasure[];
};

type RenderMeasure = {
  measure: ScoreMeasure;
  x: number;
  width: number;
  offset: number;
};

function createSystems(score: ScoreDraft): RenderSystem[] {
  const systems: RenderSystem[] = [];
  const systemHeight = Math.max(
    120,
    SYSTEM_TOP_PADDING +
      score.parts.reduce((height, part, index) => height + partHeight(part.staves.length) + (index > 0 ? PART_GAP : 0), 0) +
      SYSTEM_BOTTOM_PADDING
  );

  for (let index = 0; index < score.measures.length; index += MEASURES_PER_SYSTEM) {
    const measures = score.measures.slice(index, index + MEASURES_PER_SYSTEM);
    systems.push({
      index: systems.length,
      y: PAGE_PADDING + systems.length * (systemHeight + SYSTEM_GAP),
      height: systemHeight,
      measures: createSystemMeasureLayouts(score, measures)
    });
  }

  return systems;
}

function partHeight(staffCount: number): number {
  return STAFF_HEIGHT + Math.max(0, staffCount - 1) * STAFF_GAP;
}

function createSystemMeasureLayouts(score: ScoreDraft, measures: ScoreMeasure[]): RenderMeasure[] {
  const weights = measures.map((measure, offset) => measureWeight(score, measure, offset));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const minTotal = measures.length * MIN_MEASURE_WIDTH;
  const availableWidth = Math.max(minTotal, SYSTEM_WIDTH);
  let x = SCORE_LEFT;

  return measures.map((measure, offset) => {
    const width = Math.max(MIN_MEASURE_WIDTH, (availableWidth * weights[offset]) / totalWeight);
    const layout = { measure, x, width, offset };
    x += width;
    return layout;
  });
}

function measureWeight(score: ScoreDraft, measure: ScoreMeasure, offset: number): number {
  const chords = score.parts.flatMap((part) =>
    part.staves.flatMap((staff) =>
      staff.events.filter((event): event is ScoreChord => event.kind === "chord" && event.measureIndex === measure.index)
    )
  );
  const shortNotes = chords.filter((event) => beamCount(event.durationName) > 0).length;
  const voiceLoad = new Set(chords.map((event) => `${event.partId}:${event.staffIndex}:${event.voiceIndex}`)).size;

  return 1.6 + chords.length * 0.2 + shortNotes * 0.24 + voiceLoad * 0.12 + (offset === 0 ? 0.55 : 0);
}

type StaffSystemSvgProps = {
  score: ScoreDraft;
  system: RenderSystem;
  activeIds: Set<string>;
  playbackMap: PlaybackMapEntry[];
};

function StaffSystemSvg({ score, system, activeIds, playbackMap }: StaffSystemSvgProps) {
  let partTop = system.y + SYSTEM_TOP_PADDING;

  return (
    <g className="staff-system">
      {score.parts.map((part, partIndex) => {
        const currentPartTop = partTop + (partIndex > 0 ? PART_GAP : 0);
        const staffTops = part.staves.map((_, staffIndex) => currentPartTop + staffIndex * STAFF_GAP);
        const topLine = staffTops[0] ?? currentPartTop;
        const bottomLine = (staffTops[staffTops.length - 1] ?? currentPartTop) + STAFF_HEIGHT;
        partTop = currentPartTop + partHeight(part.staves.length);

        return (
          <g key={`${system.index}-${part.id}`} className="score-part-system">
            <text className="staff-part-name" x={SCORE_LEFT - 36} y={(topLine + bottomLine) / 2 + 4}>
              {system.index === 0 ? part.name : ""}
            </text>
            {part.staves.length > 1 ? <GrandStaffBrace x={SCORE_LEFT - 28} top={topLine} bottom={bottomLine} /> : null}
            <PartBarlines measures={system.measures} top={topLine} bottom={bottomLine} />
            {part.staves.map((staff, staffIndex) => {
              const staffTop = staffTops[staffIndex];
              return (
                <g key={`${system.index}-${part.id}-${staff.index}`}>
                  <StaffLines x1={SCORE_LEFT} x2={systemEndX(system)} y={staffTop} />
                  {system.measures.map((measureLayout) => (
                    <MeasureSvg
                      key={`${part.id}-${staff.index}-${measureLayout.measure.id}`}
                      activeIds={activeIds}
                      measureLayout={measureLayout}
                      playbackMap={playbackMap}
                      ppq={score.ppq}
                      staff={staff}
                      staffTop={staffTop}
                    />
                  ))}
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}

function systemEndX(system: RenderSystem): number {
  const lastMeasure = system.measures[system.measures.length - 1];
  return lastMeasure ? lastMeasure.x + lastMeasure.width : SCORE_LEFT + SYSTEM_WIDTH;
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

type MeasureSvgProps = {
  measureLayout: RenderMeasure;
  staff: ScoreStaff;
  staffTop: number;
  ppq: number;
  activeIds: Set<string>;
  playbackMap: PlaybackMapEntry[];
};

function MeasureSvg({
  measureLayout,
  staff,
  staffTop,
  ppq,
  activeIds,
  playbackMap
}: MeasureSvgProps) {
  const { measure, x, offset } = measureLayout;
  const events = staff.events.filter(
    (event) => event.measureIndex === measure.index && (event.kind === "chord" || event.voiceIndex === 0)
  );
  const beamGroups = createBeamGroups(
    events.filter((event): event is ScoreChord => event.kind === "chord"),
    measure,
    ppq,
    staff,
    staffTop
  );
  const beamedEventIds = new Set(beamGroups.flatMap((group) => group.events.map((event) => event.id)));

  return (
    <g className="staff-measure">
      {offset === 0 ? <ClefGlyph clef={staff.clef} x={x + 12} y={staffTop} /> : null}
      {offset === 0 ? (
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
          beamed={beamedEventIds.has(event.id)}
          event={event}
          measureLayout={measureLayout}
          playbackMap={playbackMap}
          staff={staff}
          staffTop={staffTop}
        />
      ))}
      {beamGroups.map((group) => (
        <BeamGroupSvg
          key={group.id}
          active={group.events.some((event) => activeIds.has(event.id))}
          group={group}
          measureLayout={measureLayout}
          staff={staff}
          staffTop={staffTop}
        />
      ))}
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
  measureLayout: RenderMeasure;
  staff: ScoreStaff;
  staffTop: number;
  active: boolean;
  beamed: boolean;
  playbackMap: PlaybackMapEntry[];
};

function ScoreEventSvg({ event, measureLayout, staff, staffTop, active, beamed }: ScoreEventSvgProps) {
  const x = xForEvent(event, measureLayout);
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
      {event.durationName !== "whole" && !beamed ? (
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
  if (stemDirectionForChord(event, staff, staffTop) === "down") {
    const y = lowestY(event, staff, staffTop);
    return <line className="note-stem" x1={x - 7} x2={x - 7} y1={y + 2} y2={y + 42} />;
  }

  const y = highestY(event, staff, staffTop);
  return <line className="note-stem" x1={x + 7} x2={x + 7} y1={y - 2} y2={y - 42} />;
}

type BeamGroup = {
  id: string;
  events: ScoreChord[];
  direction: StemDirection;
};

function createBeamGroups(
  chords: ScoreChord[],
  measure: ScoreMeasure,
  ppq: number,
  staff: ScoreStaff,
  staffTop: number
): BeamGroup[] {
  const groups: BeamGroup[] = [];
  const voiceIndexes = [...new Set(chords.map((chord) => chord.voiceIndex))].sort((a, b) => a - b);

  for (const voiceIndex of voiceIndexes) {
    const voiceChords = chords
      .filter((chord) => chord.voiceIndex === voiceIndex)
      .sort((a, b) => a.startTicks - b.startTicks || a.endTicks - b.endTicks);
    let current: ScoreChord[] = [];

    for (const chord of voiceChords) {
      const beatIndex = Math.floor((chord.startTicks - measure.startTicks) / ppq);
      const currentBeatIndex = current.length
        ? Math.floor((current[0].startTicks - measure.startTicks) / ppq)
        : beatIndex;
      const previous = current[current.length - 1];
      const separatedByRest = previous ? chord.startTicks > previous.endTicks + ppq / 8 : false;

      if (!isBeamable(chord) || beatIndex !== currentBeatIndex || separatedByRest) {
        pushBeamGroup(groups, current, staff, staffTop);
        current = [];
      }

      if (isBeamable(chord)) {
        current.push(chord);
      }
    }

    pushBeamGroup(groups, current, staff, staffTop);
  }

  return groups;
}

function pushBeamGroup(groups: BeamGroup[], events: ScoreChord[], staff: ScoreStaff, staffTop: number) {
  if (events.length < 2) {
    return;
  }

  const direction = stemDirectionForBeam(events, staff, staffTop);
  groups.push({
    id: `${events[0].id}-beam-${events[events.length - 1].id}`,
    events,
    direction
  });
}

function BeamGroupSvg({
  active,
  group,
  measureLayout,
  staff,
  staffTop
}: {
  active: boolean;
  group: BeamGroup;
  measureLayout: RenderMeasure;
  staff: ScoreStaff;
  staffTop: number;
}) {
  const points = createBeamPoints(group, measureLayout, staff, staffTop);
  const maxBeamCount = Math.max(...group.events.map((event) => beamCount(event.durationName)));

  return (
    <g className={`beam-group${active ? " active" : ""}`}>
      {points.map((point) => (
        <line
          key={`${point.event.id}-stem`}
          className="note-stem"
          x1={point.stemX}
          x2={point.stemX}
          y1={point.baseY}
          y2={point.beamY}
        />
      ))}
      {Array.from({ length: maxBeamCount }).map((_, beamIndex) => (
        <BeamLevelSvg
          key={beamIndex}
          beamIndex={beamIndex}
          direction={group.direction}
          points={points}
        />
      ))}
    </g>
  );
}

type BeamPoint = {
  event: ScoreChord;
  stemX: number;
  baseY: number;
  beamY: number;
};

function createBeamPoints(
  group: BeamGroup,
  measureLayout: RenderMeasure,
  staff: ScoreStaff,
  staffTop: number
): BeamPoint[] {
  const stems = group.events.map((event) => {
    const x = xForEvent(event, measureLayout);
    return {
      event,
      stemX: group.direction === "up" ? x + 7 : x - 7,
      baseY: group.direction === "up" ? highestY(event, staff, staffTop) - 2 : lowestY(event, staff, staffTop) + 2
    };
  });
  const first = stems[0];
  const last = stems[stems.length - 1];
  const anchorY =
    group.direction === "up"
      ? Math.min(...stems.map((stem) => stem.baseY)) - STEM_LENGTH
      : Math.max(...stems.map((stem) => stem.baseY)) + STEM_LENGTH;
  const slope = clamp((last.baseY - first.baseY) * 0.18, -7, 7);
  const startBeamY = anchorY - slope / 2;
  const endBeamY = anchorY + slope / 2;

  return stems.map((stem) => ({
    ...stem,
    beamY: lineYAt(stem.stemX, first.stemX, last.stemX, startBeamY, endBeamY)
  }));
}

function BeamLevelSvg({
  points,
  beamIndex,
  direction
}: {
  points: BeamPoint[];
  beamIndex: number;
  direction: StemDirection;
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

function beamSegments(points: BeamPoint[], level: number): Array<{ x1: number; x2: number; y1: number; y2: number }> {
  const segments: Array<{ x1: number; x2: number; y1: number; y2: number }> = [];
  let startIndex: number | null = null;

  for (let index = 0; index <= points.length; index += 1) {
    const point = points[index];
    const hasBeam = point ? beamCount(point.event.durationName) >= level : false;

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
        const direction = next && next.stemX < current.stemX ? -1 : 1;
        const partialLength = 18 * direction;
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

function xForEvent(event: ScoreEvent, measureLayout: RenderMeasure): number {
  const measure = measureLayout.measure;
  const measureTicks = Math.max(1, measure.endTicks - measure.startTicks);
  const localRatio = (event.startTicks - measure.startTicks) / measureTicks;
  const leading = measureLayout.offset === 0 ? CLEF_TIME_WIDTH : 20;
  const drawableWidth = Math.max(44, measureLayout.width - leading - MEASURE_END_PADDING);
  return measureLayout.x + leading + localRatio * drawableWidth;
}

function highestY(event: ScoreChord, staff: ScoreStaff, staffTop: number): number {
  return Math.min(...event.notes.map((note) => staffYForPitch(note, staff.clef, staffTop, LINE_GAP)));
}

function lowestY(event: ScoreChord, staff: ScoreStaff, staffTop: number): number {
  return Math.max(...event.notes.map((note) => staffYForPitch(note, staff.clef, staffTop, LINE_GAP)));
}

function stemDirectionForChord(event: ScoreChord, staff: ScoreStaff, staffTop: number): StemDirection {
  if (staff.voiceCount > 1) {
    return event.voiceIndex === 1 ? "down" : "up";
  }

  const centerY = (highestY(event, staff, staffTop) + lowestY(event, staff, staffTop)) / 2;
  return centerY <= staffTop + LINE_GAP * 2 ? "down" : "up";
}

function stemDirectionForBeam(events: ScoreChord[], staff: ScoreStaff, staffTop: number): StemDirection {
  if (staff.voiceCount > 1) {
    return events[0]?.voiceIndex === 1 ? "down" : "up";
  }

  const averageY =
    events.reduce((sum, event) => sum + (highestY(event, staff, staffTop) + lowestY(event, staff, staffTop)) / 2, 0) /
    Math.max(1, events.length);
  return averageY <= staffTop + LINE_GAP * 2 ? "down" : "up";
}

function isBeamable(event: ScoreChord): boolean {
  return beamCount(event.durationName) > 0 && event.dots === 0;
}

function beamCount(durationName: ScoreEvent["durationName"]): number {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function lineYAt(x: number, x1: number, x2: number, y1: number, y2: number): number {
  if (x1 === x2) {
    return y1;
  }
  return y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
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
