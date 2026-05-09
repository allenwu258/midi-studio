import { DEFAULT_SETTINGS } from "../../shared/settings";
import { buildPlaybackMap } from "../lib/playbackMap";
import { createScoreDraft } from "../lib/score";
import { ENGRAVED_RENDER_LAYOUT_OPTIONS, layoutScore } from "../lib/staff";
import type { ScoreRenderRequest, ScoreRenderResponse } from "./scoreRenderMessages";

type ScoreRenderWorkerScope = {
  postMessage(message: ScoreRenderResponse): void;
  onmessage: ((event: MessageEvent<ScoreRenderRequest>) => void) | null;
};

const workerScope = self as unknown as ScoreRenderWorkerScope;

workerScope.onmessage = (event) => {
  const { requestId, song, rendererMode, score: sourceScore } = event.data;
  const startedAt = performance.now();

  try {
    const mode = rendererMode ?? DEFAULT_SETTINGS.notationRendererMode;
    const score = sourceScore ?? createScoreDraft({ song });
    const renderScore = layoutScore(
      score,
      mode === "engraved" ? ENGRAVED_RENDER_LAYOUT_OPTIONS : undefined
    );
    const playbackMap = buildPlaybackMap(score);

    workerScope.postMessage({
      requestId,
      status: "success",
      durationMs: performance.now() - startedAt,
      score,
      renderScore,
      playbackMap
    });
  } catch (error) {
    workerScope.postMessage({
      requestId,
      status: "error",
      durationMs: performance.now() - startedAt,
      message: error instanceof Error ? error.message : "乐谱生成失败。"
    });
  }
};
