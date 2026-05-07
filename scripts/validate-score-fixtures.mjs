import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const fixtureDir = new URL("../src/renderer/lib/score/__fixtures__/", import.meta.url);
const failures = [];

try {
  const files = (await readdir(fixtureDir)).filter((file) => file.endsWith(".score.json"));

  if (!files.length) {
    failures.push("No .score.json fixtures found.");
  }

  for (const file of files) {
    const fixture = JSON.parse(await readFile(new URL(file, fixtureDir), "utf8"));
    validateScoreFixture(file, fixture);
  }
} catch (error) {
  failures.push(`Unable to read fixture directory: ${error.message}`);
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`score fixture validation: ${failure}`);
  }
  process.exit(1);
}

console.log("score fixture validation: ok");

function validateScoreFixture(file, score) {
  assert(file, typeof score.id === "string", "score.id is required");
  assert(file, Number.isInteger(score.ppq) && score.ppq > 0, "score.ppq must be a positive integer");
  assert(file, Array.isArray(score.measures) && score.measures.length > 0, "score.measures must not be empty");
  assert(file, Array.isArray(score.parts) && score.parts.length > 0, "score.parts must not be empty");

  const measureByIndex = new Map();
  for (const measure of score.measures ?? []) {
    assert(file, Number.isInteger(measure.index), "measure.index must be an integer");
    assert(file, measure.endTicks > measure.startTicks, `measure ${measure.index} has invalid tick range`);
    measureByIndex.set(measure.index, measure);
  }

  const ids = new Set();
  const eventsByTuplet = new Map();
  for (const part of score.parts ?? []) {
    assert(file, Array.isArray(part.staves) && part.staves.length > 0, `part ${part.id} has no staves`);

    for (const staff of part.staves ?? []) {
      const events = staff.events ?? [];
      for (const event of events) {
        assert(file, typeof event.id === "string" && event.id.length > 0, "event.id is required");
        assert(file, !ids.has(event.id), `duplicate event id ${event.id}`);
        ids.add(event.id);

        const measure = measureByIndex.get(event.measureIndex);
        assert(file, Boolean(measure), `event ${event.id} references missing measure ${event.measureIndex}`);
        if (measure) {
          assert(file, event.startTicks >= measure.startTicks, `event ${event.id} starts before measure`);
          assert(file, event.endTicks <= measure.endTicks, `event ${event.id} ends after measure`);
        }
        assert(file, event.endTicks > event.startTicks, `event ${event.id} has invalid duration`);
        if (event.tupletId) {
          eventsByTuplet.set(event.tupletId, [...(eventsByTuplet.get(event.tupletId) ?? []), event]);
          assert(file, Boolean(event.timeModification), `event ${event.id} has tupletId but no timeModification`);
        }
      }

      validateVoiceTimelines(file, part, staff, events, score.measures);
    }
  }

  validateTuplets(file, score, measureByIndex, eventsByTuplet);
}

function validateVoiceTimelines(file, part, staff, events, measures) {
  const voiceIndexes = [...new Set(events.map((event) => event.voiceIndex))];

  for (const voiceIndex of voiceIndexes) {
    for (const measure of measures) {
      const measureEvents = events
        .filter((event) => event.voiceIndex === voiceIndex && event.measureIndex === measure.index)
        .sort((a, b) => a.startTicks - b.startTicks || a.endTicks - b.endTicks);

      if (!measureEvents.length) {
        continue;
      }

      let cursor = measure.startTicks;
      for (const event of measureEvents) {
        assert(
          file,
          event.startTicks === cursor,
          `part ${part.id} staff ${staff.index} voice ${voiceIndex} measure ${measure.index} has a gap or overlap at ${cursor}`
        );
        cursor = event.endTicks;
      }

      assert(
        file,
        cursor === measure.endTicks,
        `part ${part.id} staff ${staff.index} voice ${voiceIndex} measure ${measure.index} does not fill measure`
      );
    }
  }
}

function validateTuplets(file, score, measureByIndex, eventsByTuplet) {
  const tuplets = score.tuplets ?? [];
  const tupletIds = new Set();

  for (const tuplet of tuplets) {
    assert(file, typeof tuplet.id === "string" && tuplet.id.length > 0, "tuplet.id is required");
    assert(file, !tupletIds.has(tuplet.id), `duplicate tuplet id ${tuplet.id}`);
    tupletIds.add(tuplet.id);

    const measure = measureByIndex.get(tuplet.measureIndex);
    assert(file, Boolean(measure), `tuplet ${tuplet.id} references missing measure ${tuplet.measureIndex}`);
    if (measure) {
      assert(file, tuplet.startTicks >= measure.startTicks, `tuplet ${tuplet.id} starts before measure`);
      assert(file, tuplet.endTicks <= measure.endTicks, `tuplet ${tuplet.id} ends after measure`);
    }

    assert(file, tuplet.endTicks > tuplet.startTicks, `tuplet ${tuplet.id} has invalid duration`);
    assert(file, tuplet.actualNotes > tuplet.normalNotes, `tuplet ${tuplet.id} must compress actual notes`);
    assert(file, Number.isInteger(tuplet.staffIndex), `tuplet ${tuplet.id} must have staffIndex`);
    assert(file, Number.isInteger(tuplet.voiceIndex), `tuplet ${tuplet.id} must have voiceIndex`);

    const events = (eventsByTuplet.get(tuplet.id) ?? []).sort((a, b) => a.startTicks - b.startTicks);
    assert(file, events.length > 0, `tuplet ${tuplet.id} has no events`);
    assert(file, new Set(events.map((event) => event.startTicks)).size === tuplet.actualNotes, `tuplet ${tuplet.id} does not cover ${tuplet.actualNotes} slots`);

    let cursor = tuplet.startTicks;
    for (const event of events) {
      assert(file, event.startTicks === cursor, `tuplet ${tuplet.id} has a gap or overlap at ${cursor}`);
      assert(file, event.timeModification?.actualNotes === tuplet.actualNotes, `event ${event.id} has mismatched actualNotes`);
      assert(file, event.timeModification?.normalNotes === tuplet.normalNotes, `event ${event.id} has mismatched normalNotes`);
      cursor = event.endTicks;
    }
    assert(file, cursor === tuplet.endTicks, `tuplet ${tuplet.id} does not fill tuplet range`);
  }

  for (const tupletId of eventsByTuplet.keys()) {
    assert(file, tupletIds.has(tupletId), `event references missing tuplet ${tupletId}`);
  }
}

function assert(file, condition, message) {
  if (!condition) {
    failures.push(`${join("src/renderer/lib/score/__fixtures__", file)}: ${message}`);
  }
}
