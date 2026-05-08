import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtureDir = new URL("../src/renderer/lib/musicxml/__fixtures__/", import.meta.url);
const manifestUrl = new URL("manifest.json", fixtureDir);
const failures = [];

let server;

try {
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
  server = await createServer({
    root: projectRoot,
    logLevel: "error",
    appType: "custom",
    server: {
      middlewareMode: true
    }
  });

  const { parseMusicXmlFile } = await server.ssrLoadModule("/src/renderer/lib/musicxml/parseMusicXml.ts");

  for (const fixture of manifest.fixtures ?? []) {
    await validateFixture(fixture, parseMusicXmlFile);
  }
} catch (error) {
  failures.push(`Unable to validate MusicXML fixtures: ${error.message}`);
} finally {
  await server?.close();
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`musicxml fixture validation: ${failure}`);
  }
  process.exit(1);
}

console.log("musicxml fixture validation: ok");

async function validateFixture(fixture, parseMusicXmlFile) {
  const { buffer, fileName } = await readFixtureBuffer(fixture);
  const result = await parseMusicXmlFile(buffer, fileName);
  const song = result.song;
  const score = result.score;
  const prefix = join("src/renderer/lib/musicxml/__fixtures__", fixture.name);

  assert(prefix, result.sourceFormat === fixture.sourceFormat, `expected sourceFormat ${fixture.sourceFormat}, got ${result.sourceFormat}`);
  assert(prefix, song.noteCount === fixture.expected.noteCount, `expected ${fixture.expected.noteCount} notes, got ${song.noteCount}`);
  assert(prefix, song.trackCount === fixture.expected.trackCount, `expected ${fixture.expected.trackCount} tracks, got ${song.trackCount}`);
  assert(
    prefix,
    song.meta.durationTicks === fixture.expected.durationTicks,
    `expected ${fixture.expected.durationTicks} duration ticks, got ${song.meta.durationTicks}`
  );
  assertAlmostEqual(prefix, song.durationMs, fixture.expected.durationMs, 0.001, "durationMs");
  assert(prefix, result.midiBytes.byteLength > 22, `generated MIDI bytes are empty (${result.midiBytes.byteLength})`);
  assert(prefix, startsWithAscii(result.midiBytes, "MThd"), "generated MIDI bytes do not start with MThd");
  assert(
    prefix,
    !result.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    `MusicXML import produced error diagnostics: ${JSON.stringify(result.diagnostics)}`
  );
  assert(
    prefix,
    !score.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    `ScoreDraft produced fatal diagnostics: ${JSON.stringify(score.diagnostics)}`
  );

  if (fixture.expected.scorePartCount !== undefined) {
    assert(prefix, score.parts.length === fixture.expected.scorePartCount, `expected ${fixture.expected.scorePartCount} score parts, got ${score.parts.length}`);
  }

  if (fixture.expected.tempoCount !== undefined) {
    assert(prefix, song.meta.tempos.length === fixture.expected.tempoCount, `expected ${fixture.expected.tempoCount} tempos, got ${song.meta.tempos.length}`);
  }

  if (fixture.expected.keySignatureCount !== undefined) {
    assert(
      prefix,
      song.meta.keySignatures.length === fixture.expected.keySignatureCount,
      `expected ${fixture.expected.keySignatureCount} key signatures, got ${song.meta.keySignatures.length}`
    );
  }

  if (fixture.expected.timeSignatureCount !== undefined) {
    assert(
      prefix,
      song.meta.timeSignatures.length === fixture.expected.timeSignatureCount,
      `expected ${fixture.expected.timeSignatureCount} time signatures, got ${song.meta.timeSignatures.length}`
    );
  }

  if (fixture.expected.measureTimeSignatures !== undefined) {
    const actual = score.measures.map((measure) => `${measure.numerator}/${measure.denominator}`);
    assert(
      prefix,
      JSON.stringify(actual) === JSON.stringify(fixture.expected.measureTimeSignatures),
      `expected measure time signatures ${JSON.stringify(fixture.expected.measureTimeSignatures)}, got ${JSON.stringify(actual)}`
    );
  }

  if (fixture.expected.maxStaffCount !== undefined) {
    const maxStaffCount = Math.max(...score.parts.map((part) => part.staves.length));
    assert(prefix, maxStaffCount === fixture.expected.maxStaffCount, `expected max staff count ${fixture.expected.maxStaffCount}, got ${maxStaffCount}`);
  }

  if (fixture.expected.scoreChordCount !== undefined) {
    const chordCount = countScoreEvents(score, "chord");
    assert(prefix, chordCount === fixture.expected.scoreChordCount, `expected ${fixture.expected.scoreChordCount} score chords, got ${chordCount}`);
  }

  if (fixture.expected.scoreRestCount !== undefined) {
    const restCount = countScoreEvents(score, "rest");
    assert(prefix, restCount === fixture.expected.scoreRestCount, `expected ${fixture.expected.scoreRestCount} score rests, got ${restCount}`);
  }

  if (fixture.expected.tupletCount !== undefined) {
    assert(prefix, score.tuplets.length === fixture.expected.tupletCount, `expected ${fixture.expected.tupletCount} tuplets, got ${score.tuplets.length}`);
  }
}

function countScoreEvents(score, kind) {
  return score.parts.reduce(
    (sum, part) =>
      sum +
      part.staves.reduce(
        (staffSum, staff) => staffSum + staff.events.filter((event) => event.kind === kind).length,
        0
      ),
    0
  );
}

async function readFixtureBuffer(fixture) {
  if (fixture.sourceFormat === "mxl") {
    const xmlText = await readFile(new URL(fixture.file, fixtureDir), "utf8");
    const rootPath = "score.xml";
    const zip = new JSZip();
    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${rootPath}" media-type="application/vnd.recordare.musicxml+xml"/>
  </rootfiles>
</container>`
    );
    zip.file(rootPath, xmlText);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { buffer: toArrayBuffer(bytes), fileName: fixture.name.endsWith(".mxl") ? fixture.name : `${fixture.name}.mxl` };
  }

  const bytes = await readFile(new URL(fixture.file, fixtureDir));
  return { buffer: toArrayBuffer(bytes), fileName: fixture.file };
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function startsWithAscii(buffer, text) {
  const bytes = new Uint8Array(buffer, 0, text.length);
  return [...text].every((char, index) => bytes[index] === char.charCodeAt(0));
}

function assertAlmostEqual(file, actual, expected, tolerance, label) {
  assert(file, Math.abs(actual - expected) <= tolerance, `expected ${label} ${expected}, got ${actual}`);
}

function assert(file, condition, message) {
  if (!condition) {
    failures.push(`${file}: ${message}`);
  }
}
