import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { NotationRendererMode } from "../../../shared/settings";
import type { ScoreDraft } from "../../lib/score";
import type { RenderScore } from "../../lib/staff";
import { renderScoreBodyToSvg, renderScoreSvgStyle } from "../../lib/staff/svgRenderer";
import {
  findActiveScorePosition,
  findSeekPositionForElement,
  type PlaybackMapEntry
} from "../../lib/playbackMap";
import {
  buildActiveEventIndex,
  isActiveRenderEvent,
  type ActiveRenderEvent
} from "./activeEvents";
import {
  createFollowViewportState,
  followPlaybackViewport,
  markManualScrollPause,
  resumeAutoFollow,
  type FollowViewportState
} from "./followViewport";
import { renderActiveScoreOverlay } from "./overlayMarkup";
import { createPlaybackCursor } from "./playbackCursor";
import { LegacyScoreSvg } from "./LegacyScoreSvg";

type StaffNotationPanelProps = {
  isRendering: boolean;
  followPlayback: boolean;
  rendererMode: NotationRendererMode;
  playbackMap: PlaybackMapEntry[];
  renderError: string;
  renderScore: RenderScore | null;
  score: ScoreDraft | null;
  getPlaybackPosition: () => number;
  onPlaybackMetrics?: (metrics: { lookupMs: number; activeEventCount: number }) => void;
  onSeek: (positionMs: number) => void;
};

export function StaffNotationPanel({
  isRendering,
  followPlayback,
  rendererMode,
  playbackMap,
  renderError,
  renderScore,
  score,
  getPlaybackPosition,
  onPlaybackMetrics,
  onSeek
}: StaffNotationPanelProps) {
  const followViewportStateRef = useRef<FollowViewportState>(createFollowViewportState());
  const activeOverlayRef = useRef<SVGGElement | null>(null);
  const scoreViewportRef = useRef<HTMLDivElement | null>(null);
  const lastOverlaySignatureRef = useRef("");
  const activeEventIndex = useMemo(
    () => (renderScore ? buildActiveEventIndex(renderScore) : new Map<string, ActiveRenderEvent>()),
    [renderScore]
  );
  const pauseAutoFollowForManualScroll = useCallback(() => {
    followViewportStateRef.current = markManualScrollPause(
      followViewportStateRef.current,
      performance.now()
    );
  }, []);

  useEffect(() => {
    const overlay = activeOverlayRef.current;

    if (!renderScore || !overlay) {
      return undefined;
    }

    const overlayElement: SVGGElement = overlay;
    lastOverlaySignatureRef.current = "";

    function updateOverlay() {
      const startedAt = performance.now();
      const playbackPositionMs = getPlaybackPosition();
      const activePosition = findActiveScorePosition(playbackMap, playbackPositionMs);
      const activeIds = Array.from(activePosition.activeIds);
      const signature = `${[...activeIds].sort().join("|")}@${Math.floor(playbackPositionMs / 125)}`;

      if (signature === lastOverlaySignatureRef.current) {
        return;
      }

      lastOverlaySignatureRef.current = signature;
      const activeEvents = activeIds.map((id) =>
        activeEventIndex.get(id)
      ).filter(isActiveRenderEvent);
      const lookupMs = performance.now() - startedAt;
      const cursor = createPlaybackCursor(playbackPositionMs, playbackMap, activeEventIndex);

      renderActiveScoreOverlay(overlayElement, activeEvents, cursor, rendererMode);
      if (followPlayback) {
        const result = followPlaybackViewport({
          activeEvents,
          cursor,
          overlay: overlayElement,
          nowMs: performance.now(),
          state: followViewportStateRef.current
        });
        followViewportStateRef.current = result.state;
      }
      onPlaybackMetrics?.({
        lookupMs,
        activeEventCount: activeEvents.length
      });
    }

    updateOverlay();
    const intervalId = window.setInterval(updateOverlay, 125);

    return () => {
      window.clearInterval(intervalId);
      followViewportStateRef.current = createFollowViewportState();
    };
  }, [activeEventIndex, followPlayback, getPlaybackPosition, onPlaybackMetrics, playbackMap, renderScore, rendererMode]);

  useEffect(() => {
    const notationPanel = scoreViewportRef.current?.parentElement;

    if (!notationPanel) {
      return undefined;
    }

    notationPanel.addEventListener("wheel", pauseAutoFollowForManualScroll, { passive: true });

    return () => {
      notationPanel.removeEventListener("wheel", pauseAutoFollowForManualScroll);
    };
  }, [pauseAutoFollowForManualScroll]);

  if (renderError) {
    return (
      <div className="empty-state">
        <strong>乐谱生成失败</strong>
        <span>{renderError}</span>
      </div>
    );
  }

  if (isRendering) {
    return (
      <div className="empty-state">
        <strong>乐谱生成中</strong>
        <span>播放线程保持独立运行</span>
      </div>
    );
  }

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
      followViewportStateRef.current = resumeAutoFollow(followViewportStateRef.current);
      onSeek(seekPosition);
    }
  }

  return (
    <div
      ref={scoreViewportRef}
      className="staff-score-viewport"
    >
      <svg
        className="staff-score"
        viewBox={`0 0 ${renderScore.width} ${renderScore.height}`}
        role="img"
        aria-label={`${score.title} 五线谱`}
        onClick={handleScoreClick}
      >
        <title>{score.title}</title>
        {rendererMode === "engraved" ? <style>{renderScoreSvgStyle()}</style> : null}
        {rendererMode === "engraved" ? (
          <StaticScoreSvg renderScore={renderScore} />
        ) : (
          <LegacyScoreSvg renderScore={renderScore} />
        )}
        <g ref={activeOverlayRef} className="active-score-overlay" aria-hidden="true" />
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

const StaticScoreSvg = memo(function StaticScoreSvg({ renderScore }: { renderScore: RenderScore }) {
  return (
    <g
      className="static-score-layer"
      dangerouslySetInnerHTML={{ __html: renderScoreBodyToSvg(renderScore) }}
    />
  );
});
