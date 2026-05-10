import type { RenderBox, RenderSystem } from "../../lib/staff";
import type { ActiveRenderEvent } from "./activeEvents";
import type { PlaybackCursor } from "./playbackCursor";

export type FollowViewportState = {
  lastSystemIndex: number | null;
  manualScrollPausedUntilMs: number;
};

export type FollowViewportRequest = {
  activeEvents: ActiveRenderEvent[];
  cursor: PlaybackCursor | null;
  overlay: SVGGElement;
  nowMs: number;
  state: FollowViewportState;
};

export type FollowViewportResult = {
  state: FollowViewportState;
};

type ScrollTarget = HTMLElement | Window;
type ScrollAxis = "x" | "y";
type FollowTarget = {
  eventBox: RenderBox;
  system: Pick<RenderSystem, "index" | "y" | "height">;
};

const MANUAL_SCROLL_PAUSE_MS = 3000;

export function createFollowViewportState(): FollowViewportState {
  return {
    lastSystemIndex: null,
    manualScrollPausedUntilMs: 0
  };
}

export function markManualScrollPause(state: FollowViewportState, nowMs: number): FollowViewportState {
  return {
    ...state,
    manualScrollPausedUntilMs: nowMs + MANUAL_SCROLL_PAUSE_MS
  };
}

export function followPlaybackViewport({
  activeEvents,
  cursor,
  overlay,
  nowMs,
  state
}: FollowViewportRequest): FollowViewportResult {
  const target = followTarget(activeEvents);
  const svg = overlay.ownerSVGElement;
  const horizontalTarget = svg ? findScrollableAncestor(svg, "x") : null;
  const verticalTarget = svg ? findScrollableAncestor(svg, "y") : null;

  if (!target || !svg || !horizontalTarget || !verticalTarget) {
    return { state };
  }

  const svgRect = svg.getBoundingClientRect();
  const horizontalRect = scrollTargetRect(horizontalTarget);
  const verticalRect = scrollTargetRect(verticalTarget);
  const viewBox = svg.viewBox.baseVal;

  if (svgRect.width <= 0 || svgRect.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) {
    return { state };
  }

  const nextState = {
    ...state,
    lastSystemIndex: target.system.index
  };
  const targetCenterX = svgToViewportX(
    cursor?.x ?? target.eventBox.x + target.eventBox.width / 2,
    svgRect,
    viewBox
  );
  const systemCenterY = svgToViewportY(
    target.system.y + target.system.height / 2,
    svgRect,
    viewBox
  );
  const systemChanged = state.lastSystemIndex !== null && state.lastSystemIndex !== target.system.index;
  const autoFollowAllowed = nowMs >= state.manualScrollPausedUntilMs;
  const shouldFollowVertically =
    autoFollowAllowed && (state.lastSystemIndex === null || systemChanged);

  const nextLeft = autoFollowAllowed
    ? nextScrollPositionForComfortZone({
        current: scrollTargetLeft(horizontalTarget),
        targetPosition: targetCenterX,
        viewportStart: horizontalRect.left,
        viewportSize: horizontalRect.width,
        minRatio: 0.22,
        maxRatio: 0.78,
        preferredRatio: 0.45
      })
    : null;
  const nextTop = shouldFollowVertically
    ? nextScrollPositionForComfortZone({
        current: scrollTargetTop(verticalTarget),
        targetPosition: systemCenterY,
        viewportStart: verticalRect.top,
        viewportSize: verticalRect.height,
        minRatio: 0.3,
        maxRatio: 0.62,
        preferredRatio: 0.42
      })
    : null;

  if (nextLeft === null && nextTop === null) {
    return { state: nextState };
  }

  if (horizontalTarget === verticalTarget) {
    scrollTargetTo(
      horizontalTarget,
      nextLeft ?? scrollTargetLeft(horizontalTarget),
      nextTop ?? scrollTargetTop(horizontalTarget)
    );
    return { state: nextState };
  }

  if (nextLeft !== null) {
    scrollTargetTo(horizontalTarget, nextLeft, scrollTargetTop(horizontalTarget));
  }
  if (nextTop !== null) {
    scrollTargetTo(verticalTarget, scrollTargetLeft(verticalTarget), nextTop);
  }

  return { state: nextState };
}

function followTarget(activeEvents: ActiveRenderEvent[]): FollowTarget | null {
  const noteEvents = activeEvents.filter((activeEvent) => activeEvent.event.notes.length > 0);

  if (!noteEvents.length) {
    return null;
  }

  const latestStartTicks = Math.max(...noteEvents.map((activeEvent) => activeEvent.event.event.startTicks));
  const targetEvents = noteEvents.filter(
    (activeEvent) => activeEvent.event.event.startTicks === latestStartTicks
  );
  const eventBox = unionRenderBoxes(targetEvents.map((activeEvent) => activeEvent.event.box));

  if (!eventBox) {
    return null;
  }

  return {
    eventBox,
    system: targetEvents[0].system
  };
}

function nextScrollPositionForComfortZone({
  current,
  targetPosition,
  viewportStart,
  viewportSize,
  minRatio,
  maxRatio,
  preferredRatio
}: {
  current: number;
  targetPosition: number;
  viewportStart: number;
  viewportSize: number;
  minRatio: number;
  maxRatio: number;
  preferredRatio: number;
}): number | null {
  const comfortStart = viewportStart + viewportSize * minRatio;
  const comfortEnd = viewportStart + viewportSize * maxRatio;

  if (targetPosition >= comfortStart && targetPosition <= comfortEnd) {
    return null;
  }

  return current + targetPosition - viewportStart - viewportSize * preferredRatio;
}

function findScrollableAncestor(start: Element, axis: ScrollAxis): ScrollTarget {
  let element: HTMLElement | null = start.parentElement;

  while (element) {
    if (isScrollableElement(element, axis)) {
      return element;
    }

    element = element.parentElement;
  }

  return window;
}

function isScrollableElement(element: HTMLElement, axis: ScrollAxis): boolean {
  const style = window.getComputedStyle(element);

  if (axis === "x") {
    return allowsScrolling(style.overflowX) && element.scrollWidth - element.clientWidth > 1;
  }

  return allowsScrolling(style.overflowY) && element.scrollHeight - element.clientHeight > 1;
}

function allowsScrolling(overflow: string): boolean {
  return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
}

function scrollTargetRect(target: ScrollTarget): Pick<DOMRect, "left" | "top" | "width" | "height"> {
  if (target instanceof Window) {
    return {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };
  }

  return target.getBoundingClientRect();
}

function scrollTargetLeft(target: ScrollTarget): number {
  return target instanceof Window ? window.scrollX : target.scrollLeft;
}

function scrollTargetTop(target: ScrollTarget): number {
  return target instanceof Window ? window.scrollY : target.scrollTop;
}

function scrollTargetTo(target: ScrollTarget, left: number, top: number): void {
  target.scrollTo({
    left,
    top,
    behavior: "smooth"
  });
}

function svgToViewportX(x: number, svgRect: DOMRect, viewBox: SVGRect): number {
  return svgRect.left + ((x - viewBox.x) / viewBox.width) * svgRect.width;
}

function svgToViewportY(y: number, svgRect: DOMRect, viewBox: SVGRect): number {
  return svgRect.top + ((y - viewBox.y) / viewBox.height) * svgRect.height;
}

function unionRenderBoxes(boxes: RenderBox[]): RenderBox | null {
  if (!boxes.length) {
    return null;
  }

  const x1 = Math.min(...boxes.map((box) => box.x));
  const y1 = Math.min(...boxes.map((box) => box.y));
  const x2 = Math.max(...boxes.map((box) => box.x + box.width));
  const y2 = Math.max(...boxes.map((box) => box.y + box.height));

  return {
    x: x1,
    y: y1,
    width: x2 - x1,
    height: y2 - y1
  };
}
