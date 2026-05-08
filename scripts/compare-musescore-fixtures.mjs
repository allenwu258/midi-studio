import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import toneMidi from "@tonejs/midi";
import { Resvg } from "@resvg/resvg-js";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { createServer } from "vite";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { Midi } = toneMidi;
const args = parseArgs(process.argv.slice(2));
const outputRoot = resolve(repoRoot, args.out ?? "artifacts/musescore-comparison");
const selectedCase = args.case;
const renderWidth = Number(args.width ?? 1600);

const fixtureSpecs = [
  {
    name: "piano-polyphony",
    title: "Piano Polyphony",
    tempo: 120,
    timeSignature: [4, 4],
    tracks: [
      {
        name: "Piano",
        program: 0,
        notes: [
          note(72, 0, 240), note(74, 240, 240), note(76, 480, 240), note(79, 720, 240),
          note(76, 960, 240), note(74, 1200, 240), note(72, 1440, 480),
          note(67, 480, 960), note(64, 480, 480),
          note(60, 1920, 240), note(64, 1920, 240), note(67, 1920, 240),
          note(69, 2160, 240), note(72, 2400, 240), note(76, 2640, 240),
          note(74, 2880, 480), note(71, 3360, 480)
        ]
      },
      {
        name: "Left Hand",
        program: 0,
        notes: [
          note(48, 0, 960), note(43, 960, 960),
          note(36, 1920, 480), note(48, 1920, 480), note(40, 2400, 480), note(52, 2400, 480),
          note(43, 2880, 960)
        ]
      }
    ]
  },
  {
    name: "triplet-syncopation",
    title: "Triplet Syncopation",
    tempo: 96,
    timeSignature: [4, 4],
    tracks: [
      {
        name: "Piano",
        program: 0,
        notes: [
          note(67, 0, 160), note(69, 160, 160), note(71, 320, 160),
          note(72, 480, 480), note(74, 960, 240), note(76, 1200, 720),
          note(55, 0, 960), note(59, 960, 480), note(62, 1440, 480),
          note(67, 1920, 160), note(71, 2240, 160),
          note(74, 2400, 480), note(72, 2880, 240), note(71, 3120, 240), note(69, 3360, 480),
          note(50, 1920, 960), note(47, 2880, 960)
        ]
      }
    ]
  }
];

await main();

async function main() {
  const specs = selectedCase
    ? fixtureSpecs.filter((fixture) => fixture.name === selectedCase)
    : fixtureSpecs;

  if (selectedCase && specs.length === 0) {
    throw new Error(`Unknown fixture case: ${selectedCase}`);
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const musescoreBin = args.skipMusescore ? null : await resolveMuseScoreBinary(args.musescore);
  const vite = await createServer({
    appType: "custom",
    logLevel: "error",
    server: { middlewareMode: true }
  });

  const manifest = {
    generatedAt: new Date().toISOString(),
    outputRoot,
    musescoreBin,
    renderWidth,
    cases: []
  };

  try {
    const { parseMidiFile } = await vite.ssrLoadModule("/src/renderer/lib/midi.ts");
    const { createScoreDraft } = await vite.ssrLoadModule("/src/renderer/lib/score/index.ts");
    const { layoutScore, renderScoreToSvg } = await vite.ssrLoadModule("/src/renderer/lib/staff/index.ts");

    for (const spec of specs) {
      manifest.cases.push(await runFixtureCase({
        spec,
        parseMidiFile,
        createScoreDraft,
        layoutScore,
        renderScoreToSvg,
        musescoreBin
      }));
    }
  } finally {
    await vite.close();
  }

  await writeJson(join(outputRoot, "manifest.json"), manifest);
  await writeFile(join(outputRoot, "index.html"), comparisonIndex(manifest), "utf8");
  console.log(`MuseScore comparison fixtures written to ${relative(repoRoot, outputRoot)}`);
}

async function runFixtureCase({
  spec,
  parseMidiFile,
  createScoreDraft,
  layoutScore,
  renderScoreToSvg,
  musescoreBin
}) {
  const caseDir = join(outputRoot, spec.name);
  await mkdir(caseDir, { recursive: true });

  const midiBytes = createMidiBytes(spec);
  const midiPath = join(caseDir, `${spec.name}.mid`);
  await writeFile(midiPath, midiBytes);

  const parsedSong = parseMidiFile(toArrayBuffer(midiBytes), basename(midiPath));
  const score = createScoreDraft({ song: parsedSong });
  const renderScore = layoutScore(score);
  const midiStudioSvg = renderScoreToSvg(renderScore);

  const midiStudioScorePath = join(caseDir, "midi-studio.score.json");
  const midiStudioRenderPath = join(caseDir, "midi-studio.render.json");
  const midiStudioSvgPath = join(caseDir, "midi-studio.svg");
  const midiStudioPngPath = join(caseDir, "midi-studio.png");

  await writeJson(midiStudioScorePath, score);
  await writeJson(midiStudioRenderPath, renderScore);
  await writeFile(midiStudioSvgPath, midiStudioSvg, "utf8");
  await rasterizeSvgFile(midiStudioSvgPath, midiStudioPngPath, renderWidth);

  const result = {
    name: spec.name,
    title: spec.title,
    files: relativeFiles(caseDir, {
      midi: midiPath,
      midiStudioScore: midiStudioScorePath,
      midiStudioRender: midiStudioRenderPath,
      midiStudioSvg: midiStudioSvgPath,
      midiStudioPng: midiStudioPngPath
    }),
    status: "midi-studio-only"
  };

  if (!musescoreBin) {
    result.warning = "MuseScore binary not found. Set MUSESCORE_BIN or pass --musescore.";
    await writeFile(join(caseDir, "comparison.html"), caseHtml(result), "utf8");
    return result;
  }

  const musescoreSvgPath = join(caseDir, "musescore.svg");
  const musescorePngPath = join(caseDir, "musescore.png");
  const musescoreXmlPath = join(caseDir, "musescore.musicxml");

  await exportWithMuseScore(musescoreBin, midiPath, musescoreSvgPath);
  await exportWithMuseScore(musescoreBin, midiPath, musescorePngPath, ["-r", "144"]);
  await exportWithMuseScore(musescoreBin, midiPath, musescoreXmlPath);

  const resolvedMuseScoreSvgPath = await firstExistingExport(musescoreSvgPath, ".svg");
  const resolvedMuseScorePngPath = await firstExistingExport(musescorePngPath, ".png");
  const normalizedMuseScorePngPath = join(caseDir, "musescore.normalized.png");
  const diffPngPath = join(caseDir, "visual-diff.png");
  const visualDiffPath = join(caseDir, "visual-diff.json");
  const structureDiffPath = join(caseDir, "structure-diff.json");

  await rasterizeSvgFile(resolvedMuseScoreSvgPath, normalizedMuseScorePngPath, renderWidth);
  const visualDiff = await diffPngFiles(midiStudioPngPath, normalizedMuseScorePngPath, diffPngPath);
  const structureDiff = await createStructureDiff(score, musescoreXmlPath);

  await writeJson(visualDiffPath, visualDiff);
  await writeJson(structureDiffPath, structureDiff);

  result.status = "compared";
  result.files = {
    ...result.files,
    musescoreSvg: relative(caseDir, resolvedMuseScoreSvgPath).replaceAll("\\", "/"),
    musescorePng: relative(caseDir, resolvedMuseScorePngPath).replaceAll("\\", "/"),
    musescoreMusicXml: relative(caseDir, musescoreXmlPath).replaceAll("\\", "/"),
    normalizedMuseScorePng: relative(caseDir, normalizedMuseScorePngPath).replaceAll("\\", "/"),
    visualDiff: relative(caseDir, diffPngPath).replaceAll("\\", "/"),
    visualDiffJson: relative(caseDir, visualDiffPath).replaceAll("\\", "/"),
    structureDiffJson: relative(caseDir, structureDiffPath).replaceAll("\\", "/")
  };
  result.visualDiff = visualDiff;
  result.structureDiff = structureDiff.summary;

  await writeFile(join(caseDir, "comparison.html"), caseHtml(result), "utf8");
  return result;
}

function note(midi, ticks, durationTicks, velocity = 0.82) {
  return { midi, ticks, durationTicks, velocity };
}

function createMidiBytes(spec) {
  const midi = new Midi();
  midi.name = spec.title;
  midi.header.setTempo(spec.tempo);
  midi.header.timeSignatures.push({
    ticks: 0,
    measures: 0,
    timeSignature: spec.timeSignature
  });
  for (const trackSpec of spec.tracks) {
    const track = midi.addTrack();
    track.name = trackSpec.name;
    track.channel = 0;
    track.instrument.number = trackSpec.program;

    for (const item of trackSpec.notes) {
      track.addNote(item);
    }
  }

  return Buffer.from(midi.toArray());
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function resolveMuseScoreBinary(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.MUSESCORE_BIN,
    "C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe",
    "C:\\Program Files\\MuseScore 3\\bin\\MuseScore3.exe"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const command of ["MuseScore4.exe", "MuseScore3.exe", "MuseScore.exe"]) {
    const resolvedCommand = await where(command);
    if (resolvedCommand) {
      return resolvedCommand;
    }
  }

  return null;
}

async function where(command) {
  try {
    const result = await runProcess("where.exe", [command], { allowFailure: true });
    return result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
  } catch {
    return null;
  }
}

async function exportWithMuseScore(musescoreBin, inputPath, outputPath, extraArgs = []) {
  await runProcess(musescoreBin, ["-f", ...extraArgs, "-o", outputPath, inputPath]);
}

async function firstExistingExport(requestedPath, extension) {
  if (existsSync(requestedPath)) {
    return requestedPath;
  }

  const folder = dirname(requestedPath);
  const prefix = basename(requestedPath, extension);
  const candidates = (await readdir(folder))
    .filter((file) => file.startsWith(prefix) && file.endsWith(extension))
    .sort();
  if (!candidates.length) {
    throw new Error(`MuseScore did not create ${requestedPath}`);
  }

  return join(folder, candidates[0]);
}

async function rasterizeSvgFile(svgPath, pngPath, width) {
  const svg = await readFile(svgPath, "utf8");
  const resvg = new Resvg(svg, {
    background: "white",
    fitTo: {
      mode: "width",
      value: width
    }
  });
  await writeFile(pngPath, resvg.render().asPng());
}

async function diffPngFiles(actualPath, expectedPath, diffPath) {
  const actual = PNG.sync.read(await readFile(actualPath));
  const expected = PNG.sync.read(await readFile(expectedPath));
  const width = Math.max(actual.width, expected.width);
  const height = Math.max(actual.height, expected.height);
  const actualCanvas = whiteCanvas(width, height);
  const expectedCanvas = whiteCanvas(width, height);
  blit(actual, actualCanvas);
  blit(expected, expectedCanvas);

  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(
    actualCanvas.data,
    expectedCanvas.data,
    diff.data,
    width,
    height,
    { threshold: 0.12, includeAA: false }
  );
  await writeFile(diffPath, PNG.sync.write(diff));

  return {
    width,
    height,
    diffPixels,
    totalPixels: width * height,
    diffRatio: Number((diffPixels / Math.max(1, width * height)).toFixed(6))
  };
}

function whiteCanvas(width, height) {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 255;
    png.data[index + 2] = 255;
    png.data[index + 3] = 255;
  }
  return png;
}

function blit(source, target) {
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      const sourceOffset = (source.width * y + x) << 2;
      const targetOffset = (target.width * y + x) << 2;
      const alpha = source.data[sourceOffset + 3] / 255;

      for (let channel = 0; channel < 3; channel += 1) {
        target.data[targetOffset + channel] = Math.round(
          source.data[sourceOffset + channel] * alpha + 255 * (1 - alpha)
        );
      }
      target.data[targetOffset + 3] = 255;
    }
  }
}

async function createStructureDiff(score, musicXmlPath) {
  const xml = await readFile(musicXmlPath, "utf8");
  const ours = summarizeScoreDraft(score);
  const musescore = summarizeMusicXml(xml);
  const deltas = {};

  for (const key of Object.keys({ ...ours, ...musescore })) {
    if (typeof ours[key] === "number" && typeof musescore[key] === "number") {
      deltas[key] = ours[key] - musescore[key];
    }
  }

  return {
    ours,
    musescore,
    deltas,
    summary: {
      noteDelta: deltas.notes ?? null,
      restDelta: deltas.rests ?? null,
      tupletDelta: deltas.tuplets ?? null,
      voiceDelta: deltas.voices ?? null,
      tieStartDelta: deltas.tieStarts ?? null
    }
  };
}

function summarizeScoreDraft(score) {
  const events = score.parts.flatMap((part) => part.staves.flatMap((staff) => staff.events));
  const chords = events.filter((event) => event.kind === "chord");
  const rests = events.filter((event) => event.kind === "rest");
  const voices = new Set(events.map((event) => `${event.partId}:${event.staffIndex}:${event.voiceIndex}`));
  const durationCounts = {};

  for (const event of events) {
    durationCounts[event.durationName] = (durationCounts[event.durationName] ?? 0) + 1;
  }

  return {
    parts: score.parts.length,
    staves: score.parts.reduce((sum, part) => sum + part.staves.length, 0),
    measures: score.measures.length,
    chords: chords.length,
    notes: chords.reduce((sum, chord) => sum + chord.notes.length, 0),
    rests: rests.length,
    tuplets: score.tuplets.length,
    voices: voices.size,
    tieStarts: chords.filter((chord) => chord.tieStart).length,
    tieStops: chords.filter((chord) => chord.tieStop).length,
    accidentals: chords.reduce((sum, chord) => sum + chord.notes.filter((item) => item.accidental !== undefined).length, 0),
    beams: 0,
    durationCounts
  };
}

function summarizeMusicXml(xml) {
  const noteBlocks = matchAll(xml, /<note\b[\s\S]*?<\/note>/g);
  const pitchedNotes = noteBlocks.filter((block) => !/<rest\b/.test(block));
  const rests = noteBlocks.filter((block) => /<rest\b/.test(block));
  const voices = new Set(matchAll(xml, /<voice>(.*?)<\/voice>/g).map((match) => stripTags(match)));
  const staves = new Set(matchAll(xml, /<staff>(.*?)<\/staff>/g).map((match) => stripTags(match)));

  return {
    parts: matchAll(xml, /<part\b/g).length,
    staves: staves.size || null,
    measures: matchAll(xml, /<measure\b/g).length,
    chords: noteBlocks.length - matchAll(xml, /<chord\b/g).length,
    notes: pitchedNotes.length,
    rests: rests.length,
    tuplets: matchAll(xml, /<time-modification>/g).length,
    voices: voices.size,
    tieStarts: matchAll(xml, /<tie\b[^>]*type="start"/g).length,
    tieStops: matchAll(xml, /<tie\b[^>]*type="stop"/g).length,
    accidentals: matchAll(xml, /<accidental>/g).length,
    beams: matchAll(xml, /<beam\b/g).length
  };
}

function matchAll(value, regex) {
  return [...value.matchAll(regex)].map((match) => match[1] ?? match[0]);
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, "").trim();
}

function relativeFiles(baseDir, files) {
  return Object.fromEntries(Object.entries(files).map(([key, value]) => [
    key,
    relative(baseDir, value).replaceAll("\\", "/")
  ]));
}

function caseHtml(result) {
  const files = result.files;
  const diff = result.visualDiff
    ? `<p>Visual diff: ${(result.visualDiff.diffRatio * 100).toFixed(2)}% (${result.visualDiff.diffPixels}/${result.visualDiff.totalPixels} pixels)</p>`
    : `<p>${result.warning ?? "MuseScore comparison was not run."}</p>`;
  const musescorePanel = files.musescoreSvg
    ? `<section><h2>MuseScore SVG</h2><img src="${files.musescoreSvg}" /></section>`
    : "";
  const diffPanel = files.visualDiff
    ? `<section><h2>PNG Diff</h2><img src="${files.visualDiff}" /></section>`
    : "";

  return htmlDocument(`${result.name} comparison`, [
    `<h1>${escapeHtml(result.title)}</h1>`,
    diff,
    `<section><h2>midi-studio SVG</h2><img src="${files.midiStudioSvg}" /></section>`,
    musescorePanel,
    diffPanel,
    `<p><a href="${files.midiStudioScore}">midi-studio score JSON</a>${files.structureDiffJson ? ` | <a href="${files.structureDiffJson}">structure diff JSON</a>` : ""}${files.visualDiffJson ? ` | <a href="${files.visualDiffJson}">visual diff JSON</a>` : ""}</p>`
  ].join("\n"));
}

function comparisonIndex(manifest) {
  return htmlDocument("MuseScore comparison fixtures", [
    "<h1>MuseScore comparison fixtures</h1>",
    `<p>Generated at ${escapeHtml(manifest.generatedAt)}.</p>`,
    "<ul>",
    manifest.cases.map((item) =>
      `<li><a href="${item.name}/comparison.html">${escapeHtml(item.name)}</a> - ${escapeHtml(item.status)}</li>`
    ).join(""),
    "</ul>"
  ].join("\n"));
}

function htmlDocument(title, body) {
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8" /><title>${escapeHtml(title)}</title>`,
    "<style>body{font-family:Arial,sans-serif;margin:24px;color:#111827}section{margin:24px 0}img{max-width:100%;border:1px solid #d0d7de;background:white}h1,h2{letter-spacing:0}</style>",
    "</head><body>",
    body,
    "</body></html>"
  ].join("");
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runProcess(command, args, options = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectProcess);
    child.on("close", (exitCode) => {
      if (exitCode === 0 || options.allowFailure) {
        resolveProcess({ exitCode, stdout, stderr });
        return;
      }

      rejectProcess(new Error(`${command} ${args.join(" ")} failed with exit code ${exitCode}\n${stderr || stdout}`));
    });
  });
}

function parseArgs(rawArgs) {
  const result = {};

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    if (key === "skip-musescore") {
      result.skipMusescore = true;
      continue;
    }

    result[key] = rawArgs[index + 1];
    index += 1;
  }

  return result;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
