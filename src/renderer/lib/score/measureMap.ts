import type { ParsedMidiMeta } from "../midi";
import type { ScoreDiagnostic, ScoreMeasure } from "./types";

export function createMeasureMap(meta: ParsedMidiMeta, diagnostics: ScoreDiagnostic[]): ScoreMeasure[] {
  const ppq = meta.ppq || 480;
  const signatures = normalizeTimeSignatures(
    [...meta.timeSignatures]
    .filter((signature) => signature.numerator > 0 && signature.denominator > 0)
      .sort((a, b) => a.ticks - b.ticks),
    ppq,
    diagnostics
  );

  if (!signatures.length) {
    diagnostics.push({
      severity: "info",
      code: "MISSING_TIME_SIGNATURE",
      message: "MIDI 未提供拍号，已按 4/4 生成五线谱。"
    });
    signatures.push({ ticks: 0, numerator: 4, denominator: 4 });
  }

  if (signatures[0].ticks !== 0) {
    signatures.unshift({ ticks: 0, numerator: signatures[0].numerator, denominator: signatures[0].denominator });
  }

  const measures: ScoreMeasure[] = [];
  let signatureIndex = 0;
  let current = signatures[0];
  let tick = 0;
  const durationTicks = Math.max(meta.durationTicks, ppq);

  while (tick < durationTicks) {
    const nextSignature = signatures[signatureIndex + 1];
    if (nextSignature && tick >= nextSignature.ticks) {
      signatureIndex += 1;
      current = signatures[signatureIndex];
      continue;
    }

    const measureTicks = ticksPerMeasure(ppq, current.numerator, current.denominator);
    const endTicks = tick + measureTicks;
    measures.push({
      id: `measure-${measures.length}`,
      index: measures.length,
      startTicks: tick,
      endTicks,
      numerator: current.numerator,
      denominator: current.denominator
    });
    tick = endTicks;
  }

  return measures;
}

export function ticksPerMeasure(ppq: number, numerator: number, denominator: number): number {
  return Math.max(1, Math.round(ppq * 4 * (numerator / denominator)));
}

type TimeSignatureLike = ParsedMidiMeta["timeSignatures"][number];

function normalizeTimeSignatures(
  signatures: TimeSignatureLike[],
  ppq: number,
  diagnostics: ScoreDiagnostic[]
): TimeSignatureLike[] {
  if (!signatures.length) {
    return signatures;
  }

  const normalized: TimeSignatureLike[] = [];
  let currentNumerator = signatures[0].numerator;
  let currentDenominator = signatures[0].denominator;

  for (const signature of signatures) {
    const measureTicks = ticksPerMeasure(ppq, currentNumerator, currentDenominator);
    const measureStart = Math.floor(signature.ticks / measureTicks) * measureTicks;
    if (signature.ticks !== 0 && signature.ticks !== measureStart) {
      diagnostics.push({
        severity: "warning",
        code: "TIME_SIGNATURE_ALIGNED_TO_MEASURE",
        message: "检测到拍号事件不在小节起点，已吸附到当前小节起点。",
        tick: signature.ticks
      });
    }

    const aligned = {
      ...signature,
      ticks: measureStart
    };
    const previousAtSameTick = normalized.findIndex((item) => item.ticks === aligned.ticks);
    if (previousAtSameTick >= 0) {
      normalized[previousAtSameTick] = aligned;
    } else {
      normalized.push(aligned);
    }

    currentNumerator = signature.numerator;
    currentDenominator = signature.denominator;
  }

  return normalized.sort((a, b) => a.ticks - b.ticks);
}
