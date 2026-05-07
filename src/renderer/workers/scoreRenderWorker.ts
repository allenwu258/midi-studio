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
  const { requestId, song } = event.data;

  try {
    const score = createScoreDraft({ song });
    const renderScore = layoutScore(score);
    const playbackMap = buildPlaybackMap(score);

    workerScope.postMessage({
      requestId,
      status: "success",
      score,
      renderScore,
      playbackMap
    });
  } catch (error) {
    workerScope.postMessage({
      requestId,
      status: "error",
      message: error instanceof Error ? error.message : "乐谱生成失败。"
    });
  }
};
