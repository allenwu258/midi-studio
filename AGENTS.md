# AGENTS.md

Guidance for coding agents working in this repository.

## Project

`midi-studio` is a React + Electron + Vite + TypeScript desktop application.
It currently contains an early local MIDI player prototype with numbered
notation, pure Web Audio synthesis, alphaSynth + SF2 playback, and persistent
settings. Staff notation, piano keyboard visualization, and advanced exports
are not implemented yet.

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

- `src/main/`: Electron main process and application lifecycle.
- `src/preload/`: Safe bridge between Electron and renderer.
- `src/renderer/`: React UI and player prototype.
- `src/renderer/lib/midi.ts`: MIDI parsing and normalized song model.
- `src/renderer/lib/notation.ts`: numbered notation and time formatting helpers.
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
- Do not commit generated folders such as `node_modules`, `dist`, or `logs`.
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
npm run build
```

For packaging configuration changes, run at least:

```bash
npm run typecheck
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

The prototype supports local MIDI import, numbered notation, pure synthesis,
alphaSynth + SF2 playback, persistent settings, basic transport controls,
seeking, speed changes, and master volume. The next major work should be
planned before implementation, especially around:

- Offline rendering.
- Score rendering.
- Timeline synchronization.

## Notes For Future Agents

- Read `README.md` before changing project structure.
- Preserve user changes in the working tree.
- Prefer small patches with clear verification.
- If a command fails because the dev server is already running, inspect the
  existing process before starting another one.
