import { buildPlaybackMap } from "../lib/playbackMap";
import { createScoreDraft } from "../lib/score";
import { layoutScore } from "../lib/staff";
import type { ScoreRenderRequest, ScoreRenderResponse } from "./scoreRenderMessages";

type ScoreRenderWorkerScope = {
  postMessage(message: ScoreRenderResponse): void;
  onmessage: ((event: MessageEvent<ScoreRenderRequest>) => void) | null;
};

const workerScope = self as unknown as ScoreRenderWorkerScope;

workerScope.onmessage = (event) => {
  const { requestId, song, score: sourceScore } = event.data;
  const startedAt = performance.now();

  try {
    const score = sourceScore ?? createScoreDraft({ song });
    const renderScore = layoutScore(score);
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
