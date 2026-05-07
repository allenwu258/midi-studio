import type { ParsedSong } from "../lib/midi";
import type { PlaybackMapEntry } from "../lib/playbackMap";
import type { ScoreDraft } from "../lib/score";
import type { RenderScore } from "../lib/staff";

export type ScoreRenderRequest = {
  requestId: number;
  song: ParsedSong;
};

export type ScoreRenderSuccess = {
  requestId: number;
  status: "success";
  durationMs: number;
  score: ScoreDraft;
  renderScore: RenderScore;
  playbackMap: PlaybackMapEntry[];
};

export type ScoreRenderFailure = {
  requestId: number;
  status: "error";
  durationMs: number;
  message: string;
};

export type ScoreRenderResponse = ScoreRenderSuccess | ScoreRenderFailure;
