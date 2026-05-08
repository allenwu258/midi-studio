import type {
  Clef,
  ScoreDraft,
  ScoreEvent,
  ScorePart,
  ScoreStaff,
  ScoreTuplet
} from "../score";
import type {
  MusicXmlClefSign,
  MusicXmlScoreChord,
  MusicXmlScoreEvent,
  MusicXmlScoreSource
} from "./types";

export function toScoreDraft(source: MusicXmlScoreSource): ScoreDraft {
  const tuplets = createTuplets(source);
  const tupletIdByEventId = new Map<string, string>();

  for (const tuplet of tuplets) {
    for (const event of eventsForTuplet(source, tuplet)) {
      tupletIdByEventId.set(event.id, tuplet.id);
    }
  }

  const parts: ScorePart[] = source.parts.map((part) => {
    const staves: ScoreStaff[] = [];
    for (let staffIndex = 1; staffIndex <= part.staves; staffIndex += 1) {
      const staffEvents = part.events
        .filter((event) => event.staffIndex === staffIndex)
        .map((event) => toScoreEvent(event, tupletIdByEventId.get(event.id)))
        .sort((a, b) => a.startTicks - b.startTicks || a.voiceIndex - b.voiceIndex || a.endTicks - b.endTicks);
      const voiceCount = Math.max(1, ...staffEvents.map((event) => event.voiceIndex));

      staves.push({
        index: staffIndex,
        clef: clefForStaff(part.clefs.find((clef) => clef.staffIndex === staffIndex)?.sign, staffEvents),
        voiceCount,
        events: staffEvents
      });
    }

    return {
      id: part.id,
      name: part.name,
      sourceTrackIndex: part.sourceTrackIndex,
      sourceTrackIndexes: [part.sourceTrackIndex],
      program: part.program,
      isDrum: part.isDrum,
      staves
    };
  });

  return {
    id: `score-${source.id}`,
    title: source.title,
    ppq: source.ppq,
    durationMs: source.durationMs,
    durationTicks: source.durationTicks,
    measures: source.measures.map((measure) => ({
      id: measure.id,
      index: measure.index,
      startTicks: measure.startTicks,
      endTicks: measure.endTicks,
      numerator: measure.attributes.timeSignature.numerator,
      denominator: measure.attributes.timeSignature.denominator
    })),
    parts,
    tuplets,
    diagnostics: []
  };
}

function toScoreEvent(event: MusicXmlScoreEvent, tupletId: string | undefined): ScoreEvent {
  const base = {
    id: event.id,
    baseId: event.baseId,
    partId: event.partId,
    staffIndex: event.staffIndex,
    voiceIndex: event.voiceIndex,
    measureIndex: event.measureIndex,
    startTicks: event.startTicks,
    endTicks: event.endTicks,
    startMs: event.startMs,
    endMs: event.endMs,
    durationName: event.durationName,
    dots: event.dots,
    tupletId,
    timeModification: event.timeModification
  };

  if (event.kind === "rest") {
    return {
      ...base,
      kind: "rest"
    };
  }

  return {
    ...base,
    kind: "chord",
    notes: event.notes,
    sourceNoteIds: event.sourceNoteIds,
    tieStart: event.tieStart,
    tieStop: event.tieStop
  };
}

function createTuplets(source: MusicXmlScoreSource): ScoreTuplet[] {
  const tuplets: ScoreTuplet[] = [];

  for (const part of source.parts) {
    const grouped = new Map<string, MusicXmlScoreChord[]>();
    for (const event of part.events) {
      if (event.kind !== "chord" || !event.timeModification) {
        continue;
      }

      const key = [
        part.id,
        event.staffIndex,
        event.voiceIndex,
        event.measureIndex,
        event.timeModification.actualNotes,
        event.timeModification.normalNotes
      ].join(":");
      grouped.set(key, [...(grouped.get(key) ?? []), event]);
    }

    for (const events of grouped.values()) {
      const sorted = [...events].sort((a, b) => a.startTicks - b.startTicks || a.endTicks - b.endTicks);
      if (sorted.length < 2) {
        continue;
      }

      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      const actualNotes = first.timeModification?.actualNotes ?? 0;
      const normalNotes = first.timeModification?.normalNotes ?? 0;
      const slotTicks = Math.max(1, Math.min(...sorted.map((event) => event.endTicks - event.startTicks)));
      const startTicks = first.startTicks;

      tuplets.push({
        id: `${first.partId}-tuplet-${first.measureIndex}-${first.staffIndex}-${first.voiceIndex}-${startTicks}`,
        baseId: `${first.partId}-tuplet-${first.measureIndex}-${first.staffIndex}-${first.voiceIndex}-${startTicks}`,
        partId: first.partId,
        sourceTrackIndex: part.sourceTrackIndex,
        staffIndex: first.staffIndex,
        voiceIndex: first.voiceIndex,
        measureIndex: first.measureIndex,
        startTicks,
        endTicks: last.endTicks,
        slotTicks,
        slots: sorted.map((event) => Math.max(0, Math.round((event.startTicks - startTicks) / slotTicks))),
        actualNotes,
        normalNotes
      });
    }
  }

  return tuplets;
}

function eventsForTuplet(source: MusicXmlScoreSource, tuplet: ScoreTuplet): MusicXmlScoreChord[] {
  const part = source.parts.find((item) => item.id === tuplet.partId);
  if (!part) {
    return [];
  }

  return part.events.filter(
    (event): event is MusicXmlScoreChord =>
      event.kind === "chord" &&
      event.staffIndex === tuplet.staffIndex &&
      event.voiceIndex === tuplet.voiceIndex &&
      event.measureIndex === tuplet.measureIndex &&
      event.timeModification?.actualNotes === tuplet.actualNotes &&
      event.timeModification.normalNotes === tuplet.normalNotes &&
      event.startTicks >= tuplet.startTicks &&
      event.endTicks <= tuplet.endTicks
  );
}

function clefForStaff(sign: MusicXmlClefSign | undefined, events: ScoreEvent[]): Clef {
  if (sign === "F") {
    return "bass";
  }
  if (sign === "percussion") {
    return "percussion";
  }
  if (sign === "G") {
    return "treble";
  }

  const chordNotes = events.flatMap((event) => (event.kind === "chord" ? event.notes : []));
  const averagePitch = chordNotes.reduce((sum, note) => sum + note.midi, 0) / Math.max(1, chordNotes.length);
  return averagePitch < 60 ? "bass" : "treble";
}
