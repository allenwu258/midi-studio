import type { NotationRendererMode } from "../../../shared/settings";
import type { RenderScore } from "./types";
import { renderLegacyScoreBodyToSvg, renderLegacyScoreSvgStyle } from "./legacySvgRenderer";
import { renderScoreBodyToSvg, renderScoreSvgStyle } from "./svgRenderer";

export function renderScoreToSvg(renderScore: RenderScore, rendererMode: NotationRendererMode): string {
  const body = rendererMode === "engraved"
    ? renderScoreBodyToSvg(renderScore)
    : renderLegacyScoreBodyToSvg(renderScore);
  const style = rendererMode === "engraved"
    ? renderScoreSvgStyle()
    : renderLegacyScoreSvgStyle();
  const background = rendererMode === "engraved"
    ? `<rect class="score-page-background" x="0" y="0" width="${renderScore.width}" height="${renderScore.height}" />`
    : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" class="staff-score" viewBox="0 0 ${renderScore.width} ${renderScore.height}" role="img" aria-label="${escapeAttribute(renderScore.score.title)} five-line score">`,
    `<title>${escapeHtml(renderScore.score.title)}</title>`,
    `<style>${style}</style>`,
    background,
    body,
    "</svg>"
  ].join("");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
