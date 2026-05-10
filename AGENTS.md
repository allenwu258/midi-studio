# AGENTS.md

Guidance for coding agents working in this repository.

## Project

`midi-studio` is a React + Electron + Vite + TypeScript desktop application.
It is now centered on local MIDI playback plus a structured staff-notation
pipeline. The app supports local MIDI import, worker-based MIDI parsing,
alphaSynth + SF2 playback, pure Web Audio fallback, persistent settings, staff
notation rendering, playback-to-score mapping, and playback reliability
diagnostics. Piano keyboard visualization, MusicXML export, and advanced export
workflows are still planned.

## Working Directory

Repository root:

```text
C:\Users\Trivedi\projects\midi-studio
```

## Commands

Install dependencies:

```bash
npm install
```

Run development mode:

```bash
npm run dev
```

Type-check:

```bash
npm run typecheck
```

Validate score fixtures:

```bash
npm run validate:score-fixtures
```

Build:

```bash
npm run build
```

Build a Windows portable executable:

```bash
npm run dist:portable
```

The portable artifact is written to `release/`, which is ignored by git.

## Code Ownership

- `src/main/`: Electron main process, application lifecycle, settings IPC, and
  custom resource protocol.
- `src/preload/`: Safe bridge between Electron and renderer.
- `src/renderer/`: React UI, playback UI, staff notation UI, and renderer-side
  workers.
- `src/renderer/lib/midi.ts`: MIDI parsing and normalized song model.
- `src/renderer/lib/score/`: MIDI-to-ScoreDraft conversion, quantization,
  rhythm spelling, pitch spelling, piano split, tuplets, and voice separation.
- `src/renderer/lib/staff/`: RenderScore layout, spacing, beams, glyph metrics,
  collision handling, and SVG export helpers.
- `src/renderer/lib/playbackMap/`: score element to playback-time mapping.
- `src/renderer/features/notation/`: staff notation React UI and playback
  overlay.
- `src/renderer/workers/`: MIDI parse worker and score render worker.
- `src/renderer/lib/time.ts`: time formatting helpers.
- `src/renderer/lib/synthPlayer.ts`: pure Web Audio playback engine.
- `src/renderer/lib/player/alphaSynthPlayer.ts`: alphaSynth + SF2 playback
  engine wrapper.
- `src/renderer/lib/player/createPlayer.ts`: playback engine factory.
- `src/main/settings/`: SQLite-backed settings storage and IPC handlers.
- `src/main/resources/resourceProtocol.ts`: Electron custom protocol for
  bundled alphaSynth/SF2 resources.
- `public/vendor/alphasynth/`: bundled alphaSynth browser script.
- `public/soundfonts/`: bundled SF2 SoundFont assets.
- `vite.config.ts`: Renderer build and dev server configuration.
- `tsconfig.electron.json`: Electron main/preload TypeScript build.
- `tsconfig.json`: Renderer TypeScript configuration.

## Engineering Rules

- Keep the app secure by default:
  - Keep `contextIsolation: true`.
  - Keep `nodeIntegration: false`.
  - Expose only small, typed APIs through preload.
- Prefer TypeScript types over implicit `any`.
- Keep feature work isolated from infrastructure changes.
- Do not commit generated folders such as `node_modules`, `dist`, `logs`, or
  local comparison artifacts.
- Do not introduce large framework changes without a clear reason.
- Keep dependencies conservative while the project still targets Node 16.
- Keep `release/` ignored; portable executables must not be committed.
- Do not enable Windows signing/resource editing unless the build environment
  has the required signing and symlink permissions.
- Do not import files from `public/` in renderer source. Runtime audio assets
  must be loaded through `midi-studio-resource://assets/...`.
- Do not replace bundled SF2 assets without confirming redistribution rights
  and updating README documentation.
- Preserve the player switch order in `App`: create and load the new engine
  first, validate the load generation/current MIDI/current player, then dispose
  the old engine. Disposing the old player first can lose the working fallback.
- Preserve the settings save queue in `App`; settings writes are serialized so
  rapid slider or mode changes cannot apply older SQLite responses last.
- Keep MIDI parsing and score rendering off the main thread unless there is a
  measured reason to change that boundary.
- Do not reintroduce playback-position-driven React rerenders for staff
  highlighting; use the existing clock/overlay separation.

## Branch Naming

Use descriptive branch prefixes that communicate the intent of the work. Do not
put every branch under `codex/`.

Preferred prefixes:

- `feat/<short-description>` for user-visible features or new capabilities.
- `fix/<short-description>` for bug fixes, regressions, and reliability work.
- `chore/<short-description>` for tooling, scripts, maintenance, and repository
  housekeeping that does not change app behavior.
- `docs/<short-description>` for documentation-only work.
- `refactor/<short-description>` for internal restructuring without intended
  behavior changes.
- `test/<short-description>` for test-only or fixture-only work.

Naming rules:

- Keep the description lowercase kebab-case, for example
  `feat/musicxml-export`, `fix/playback-seek-pops`, or
  `chore/musescore-comparison-fixtures`.
- Prefer the smallest accurate prefix. If a change contains code and docs, use
  the code-facing prefix such as `feat/` or `fix/`.
- Reserve `codex/<short-description>` only for disposable local experiments
  that are not expected to be pushed or kept on GitHub.
- Before pushing a long-lived branch, rename any temporary `codex/` branch to
  the appropriate semantic prefix.

## Frontend Rules

- Match the current quiet desktop-tool style.
- Build real application screens instead of marketing pages.
- Keep controls compact and predictable.
- Avoid decorative UI that does not help MIDI playback, score reading, or
  practice workflows.
- Do not add visible instructional copy for interactions that should be
  self-evident.

## Verification

For scaffold or infrastructure changes, run:

```bash
npm run typecheck
npm run validate:score-fixtures
npm run build
```

For packaging configuration changes, run at least:

```bash
npm run typecheck
npm run validate:score-fixtures
npm run build
```

Run `npm run dist:portable` only when explicitly asked, because it downloads
Electron/builder binaries and writes portable artifacts to `release/`.

When touching alphaSynth/SF2 loading, also verify:

```bash
npm run build
```

Then check that `dist/renderer/vendor/alphasynth/alphaSynth.min.js` and
`dist/renderer/soundfonts/midiSound-2025-1-14.sf2` exist.

For UI changes, also launch:

```bash
npm run dev
```

Then verify the renderer at:

```text
http://127.0.0.1:5173
```

React dev mode may remount the app under StrictMode. `App` intentionally delays
player disposal by one task and cancels it on immediate remount, so do not
simplify that cleanup back to unconditional dispose without checking dev audio
loading behavior.

## Current Feature Boundary

The current feature branch supports local MIDI import, staff notation rendering,
score playback highlighting, click-to-seek mapping, pure synthesis fallback,
alphaSynth + SF2 playback, persistent settings, transport controls, seeking,
speed changes, and master volume. Current active work is improving notation
quality and reliability, especially around:

- Quantization, duration spelling, tuplets, and voice separation.
- Engraving geometry, spacing, and collision avoidance.
- MusicXML export.
- Piano keyboard visualization.
- Offline score/audio export.

## Notes For Future Agents

- Read `README.md` before changing project structure. `README.md` is the
  Chinese primary README; `README.en.md` is the English version.
- Read `docs/system-architecture-and-technical-implementation.md` before
  changing the MIDI import, score rendering, playback, or worker boundaries.
- Preserve user changes in the working tree.
- Prefer small patches with clear verification.
- If a command fails because the dev server is already running, inspect the
  existing process before starting another one.
