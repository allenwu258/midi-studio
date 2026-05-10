import type {
  RenderBeamGroup,
  RenderEvent,
  RenderScore,
  RenderSystem,
  RenderTuplet
} from "../../lib/staff";

export type ActiveRenderEvent = {
  event: RenderEvent;
  system: RenderSystem;
  beams: RenderBeamGroup[];
  tuplets: RenderTuplet[];
};

export function buildActiveEventIndex(renderScore: RenderScore): Map<string, ActiveRenderEvent> {
  const index = new Map<string, ActiveRenderEvent>();
  const beamsByEventId = new Map<string, RenderBeamGroup[]>();
  const tupletsByEventId = new Map<string, RenderTuplet[]>();

  for (const system of renderScore.systems) {
    for (const part of system.parts) {
      for (const staff of part.staves) {
        for (const beam of staff.beams) {
          for (const eventId of beam.eventIds) {
            const beams = beamsByEventId.get(eventId);
            if (beams) {
              beams.push(beam);
            } else {
              beamsByEventId.set(eventId, [beam]);
            }
          }
        }

        for (const tuplet of staff.tuplets) {
          for (const eventId of tuplet.eventIds) {
            const tuplets = tupletsByEventId.get(eventId);
            if (tuplets) {
              tuplets.push(tuplet);
            } else {
              tupletsByEventId.set(eventId, [tuplet]);
            }
          }
        }

        for (const event of staff.events) {
          if (event.event.kind === "rest") {
            continue;
          }

          index.set(event.event.id, {
            event,
            system,
            beams: beamsByEventId.get(event.event.id) ?? [],
            tuplets: tupletsByEventId.get(event.event.id) ?? []
          });
        }
      }
    }
  }

  return index;
}

export function isActiveRenderEvent(event: ActiveRenderEvent | undefined): event is ActiveRenderEvent {
  return Boolean(event);
}
