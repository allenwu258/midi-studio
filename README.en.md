# midi-studio

midi-studio is an open-source local-first desktop MIDI practice studio built
with React, Electron, Vite, and TypeScript.

The current version can open local MIDI and MusicXML files, parse them in
workers, play them through either a pure Web Audio fallback or a bundled
alphaSynth + SF2 engine, and render a structured staff-notation view
synchronized with playback.

Chinese README: [README.md](README.md)

## Current Status

- Local `.mid` / `.midi` import.
- Local `.xml` / `.musicxml` / `.mxl` import, with MusicXML parsing and score
  preparation running off the main thread.
- MIDI parsing through `@tonejs/midi` in a renderer worker.
- alphaSynth + SF2 SoundFont playback, with AudioWorklet preference and
  ScriptProcessor fallback diagnostics.
- Pure Web Audio synth fallback.
- Playback controls: play, pause, stop, seek, speed, and master volume.
- The bottom transport bar is locked to the window bottom by default and can be
  unlocked back into the page flow; the follow-playback control also lives in
  the transport, defaults on, and is not persisted to SQLite.
- Persistent settings backed by SQLite.
  - Playback mode can switch between `SF2 Synth` and `Basic MIDI`.
  - Notation rendering can switch between `Engraved SVG` and `Classic JSX`.
- MIDI-to-staff pipeline:
  - measure map and time signature alignment;
  - pitch spelling with key awareness;
  - piano grand-staff splitting;
  - measure-level quantization beam search;
  - duration spelling, rests, ties, and basic tuplets;
  - voice split window search;
  - playback map for score highlighting and seeking.
- MusicXML import pipeline:
  - preserves source voice/staff, note type/dots, tuplet/time-modification,
    tie semantics, and measure attributes;
  - builds `ScoreDraft` directly for notation while still generating MIDI
    bytes for alphaSynth playback;
  - supports compressed `.mxl` container extraction;
  - `npm run validate:musicxml-fixtures` covers single voice, chords, rests,
    backup/forward, multiple voices, grand staff, ties, tempo, key/time changes,
    tuplets, and `.mxl`.
- Staff renderer:
  - switchable `Engraved SVG` and `Classic JSX` rendering paths, with
    `Engraved SVG` as the default and the old JSX renderer preserved as a
    fallback/comparison path;
  - `Engraved SVG` shares the same SVG markup/style helpers between the screen
    renderer and SVG export;
  - SVG staff systems, clefs, measures, notes, rests, ties, beams, tuplets;
  - time-slice spacing, glyph boxes, and baseline collision avoidance;
  - imperative playback overlay to avoid React rerender pressure;
  - follow-playback scrolling targets the current active score event by tick
    position and resolves horizontal/vertical scroll containers independently.
- Playback reliability diagnostics:
  - output mode and fallback reason;
  - alphaSynth load timings;
  - parse/render worker timings;
  - playback long-task observation;
  - overlay update metrics.

## Requirements

- Node.js 16.19 or newer.
- npm 8 or newer.

Dependency versions are kept conservative because the project still targets
Node 16.

## Getting Started

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run dev
```

The renderer development server runs at:

```text
http://127.0.0.1:5173
```

Build the app:

```bash
npm run build
```

Build a Windows portable executable:

```bash
npm run dist:portable
```

The portable build is written to `release/`, which is ignored by git.

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Starts Vite and Electron together. |
| `npm run dev:renderer` | Starts the Vite renderer server only. |
| `npm run dev:electron` | Waits for Vite, compiles Electron code, and starts Electron. |
| `npm run build` | Builds Electron main/preload code and the renderer bundle. |
| `npm run dist:dir` | Builds an unpacked Windows app directory for packaging debug. |
| `npm run dist:portable` | Builds an unsigned Windows portable executable. |
| `npm run preview` | Serves the built renderer bundle locally. |
| `npm run typecheck` | Runs TypeScript checks for renderer and Electron code. |
| `npm run validate:score-fixtures` | Validates checked-in score JSON fixtures. |
| `npm run validate:musicxml-fixtures` | Validates checked-in MusicXML import fixtures. |

## Project Layout

```text
midi-studio/
  src/
    main/          Electron main process, resources, settings IPC
    preload/       Isolated bridge exposed to the renderer
    renderer/
      features/    React feature screens and notation UI
      lib/
        midi.ts    MIDI parsing and normalized song model
        player/    alphaSynth / WebAudio playback engines
        score/     MIDI-to-ScoreDraft algorithms
        staff/     RenderScore layout, Engraved/Classic SVG rendering, export helpers
        playbackMap/
        time.ts
      workers/     MIDI parse and score render workers
  public/
    soundfonts/    Bundled SF2 SoundFont assets
    vendor/        Bundled alphaSynth browser script
```

## Architecture Notes

- The renderer runs as a React application.
- The Electron main process owns the desktop window lifecycle.
- The preload script is the only bridge between the renderer and privileged
  Electron APIs.
- `contextIsolation` is enabled and `nodeIntegration` is disabled.
- alphaSynth and SF2 assets are loaded through
  `midi-studio-resource://assets/...`.
- MIDI parsing and score rendering run in workers so notation work does not
  block the playback-critical UI path.
- The score render worker receives the current notation renderer mode and
  chooses matching layout options for `Engraved SVG` or `Classic JSX`.
- The playback clock is decoupled from React state; score highlighting uses an
  imperative overlay and throttled diagnostics.
- The bottom transport can be locked as a fixed toolbar; the renderer reserves
  bottom space from the measured toolbar height to avoid covering notation.
- Follow playback is a session-local transport control. It defaults on, does
  not belong to SQLite settings, and disabling it stops auto-scroll while
  keeping score highlighting active.

For the complete architecture and technical implementation details, see:

```text
docs/system-architecture-and-technical-implementation.md
```

## Verification

Before opening a pull request, run:

```bash
npm run typecheck
npm run validate:score-fixtures
npm run build
```

For UI changes, also run:

```bash
npm run dev
```

Then check:

```text
http://127.0.0.1:5173
```

## Bundled Audio Assets

The SF2 engine uses these local assets:

```text
public/vendor/alphasynth/alphaSynth.min.js
public/soundfonts/midiSound-2025-1-14.sf2
```

Do not replace the bundled SF2 file without confirming redistribution rights
and updating this documentation.

## Roadmap

- Improve quantization with broader tuplet candidates and fixture-driven
  penalty calibration.
- Improve engraving geometry with stronger spacing, collision solving, real
  SMuFL fonts, and glyph metrics.
- Expand MusicXML import coverage and score fidelity before export work.
- Add MusicXML export from `ScoreDraft`.
- Add piano keyboard visualization.
- Add export workflows for score images/PDF and offline audio.
- Expand reliability diagnostics for playback and rendering.

## License

MIT
