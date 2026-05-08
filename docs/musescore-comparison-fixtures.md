# MuseScore Comparison Fixtures

This fixture pipeline compares the midi-studio score reconstruction and SVG
layout against MuseScore exports for the same deterministic MIDI inputs.

Run:

```bash
npm run compare:musescore
```

Outputs are written to:

```text
artifacts/musescore-comparison/
```

The generated artifacts include:

- `*.mid`: deterministic MIDI input for the case.
- `midi-studio.score.json`: our structured score draft.
- `midi-studio.render.json`: our layout tree.
- `midi-studio.svg` and `midi-studio.png`: our visual output.
- `musescore.svg`, `musescore.png`, and `musescore.musicxml`: MuseScore exports.
- `visual-diff.png` and `visual-diff.json`: normalized raster comparison.
- `structure-diff.json`: coarse structural summary and deltas.
- `comparison.html`: side-by-side visual report for the case.
- `index.html`: report index.

MuseScore is auto-detected from common Windows install paths. Override it with:

```bash
npm run compare:musescore -- --musescore "C:\Program Files\MuseScore 4\bin\MuseScore4.exe"
```

To run only the midi-studio side without MuseScore installed:

```bash
npm run compare:musescore -- --skip-musescore
```

To run one fixture:

```bash
npm run compare:musescore -- --case piano-polyphony
```

## Reading Results

Use `comparison.html` first. The PNG diff is intentionally strict: it is a
regression signal, not a pass/fail quality score. Large diffs are expected while
the engraving engine is still catching up with MuseScore.

Use `structure-diff.json` to inspect notation semantics. Useful early signals:

- `noteDelta`: different note/chord materialization.
- `restDelta`: different hidden/visible rest policy.
- `tupletDelta`: different tuplet recognition.
- `voiceDelta`: different voice/layer inference.
- `tieStartDelta`: different duration spelling or cross-boundary tie handling.

The fixture MIDI data is generated inside the script so binary MIDI files do
not need to be committed. Add new cases by extending `fixtureSpecs` in
`scripts/compare-musescore-fixtures.mjs`.
