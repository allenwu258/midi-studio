# midi-studio

midi-studio is an open-source desktop MIDI practice studio built with React,
Electron, Vite, and TypeScript.

The current version is an early playable prototype. It can open local MIDI
files, parse note events, play them through either a lightweight Web Audio
synthesizer or a bundled alphaSynth + SF2 engine, show numbered notation, and
highlight playback progress. Full staff notation, piano keyboard visualization,
and advanced export workflows are planned but not part of this version yet.

## Goals

- Provide a local-first desktop MIDI player and practice workspace.
- Render notation and piano-roll style playback in sync with audio.
- Support higher quality audio paths such as soundfont-backed playback and
  offline rendered audio.
- Keep the UI simple, fast, and useful for repeated practice sessions.

## Current Status

- Electron main process scaffolded.
- Secure preload bridge scaffolded.
- React renderer scaffolded.
- Vite development server configured.
- TypeScript compilation configured for renderer and Electron code.
- Local `.mid` / `.midi` file import.
- MIDI parsing through `@tonejs/midi`.
- Numbered notation rendering.
- Pure Web Audio synthesis playback.
- alphaSynth + SF2 SoundFont playback.
- Playback controls: play, pause, stop, seek, and speed.
- Settings page for playback mode, default speed, master volume, and follow
  playback.
- SQLite-backed persistent settings.
- Windows portable `.exe` packaging configuration.

## Requirements

- Node.js 16.19 or newer.
- npm 8 or newer.

The initial dependency versions are selected to run on the current local Node
16 environment. Future releases may raise the minimum Node version after the
core architecture is stable.

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

The portable build is written to:

```text
release/midi-studio-0.1.0-portable.exe
```

This build is unsigned. Windows may show a SmartScreen warning until the app is
code-signed.

Preview the built renderer:

```bash
npm run preview
```

Run type checks:

```bash
npm run typecheck
```

## Scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Starts Vite and Electron together. |
| `npm run dev:renderer` | Starts the Vite renderer server only. |
| `npm run dev:electron` | Waits for Vite, compiles Electron code, and starts Electron. |
| `npm run build` | Builds Electron main/preload code and the renderer bundle. |
| `npm run dist:dir` | Builds an unpacked Windows app directory for debugging packaging output. |
| `npm run dist:portable` | Builds an unsigned Windows portable executable. |
| `npm run preview` | Serves the built renderer bundle locally. |
| `npm run typecheck` | Runs TypeScript checks for both renderer and Electron projects. |

## Project Layout

```text
midi-studio/
  src/
    main/       Electron main process
    preload/    Isolated bridge exposed to the renderer
    renderer/   React application and MIDI player prototype
  public/
    soundfonts/ Bundled SF2 SoundFont assets
    vendor/     Bundled browser-side vendor assets
  index.html    Vite HTML entry
```

## Architecture Notes

- The renderer runs as a normal React application.
- The Electron main process owns the desktop window lifecycle.
- The preload script is the only bridge between the renderer and privileged
  Electron APIs.
- `contextIsolation` is enabled and `nodeIntegration` is disabled in the
  renderer window.
- User settings are stored by the Electron main process in SQLite. Development
  uses `data/midi-studio.sqlite3` under the repo root. Portable builds use
  `data/midi-studio.sqlite3` next to the portable executable, using
  `PORTABLE_EXECUTABLE_DIR` when available.
- alphaSynth and SF2 assets are served to the renderer through the Electron
  custom protocol `midi-studio-resource://assets/...`. This keeps development
  and portable builds on the same resource loading path and avoids importing
  public assets through Vite transforms.
- Development loads the renderer from Vite.
- Production loads the built renderer from `dist/renderer/index.html`.
- Windows portable builds disable executable signing/resource editing with
  `win.signAndEditExecutable: false` so unsigned portable builds do not require
  local symlink privileges for `winCodeSign`.

## Packaging Notes

The project targets portable Windows builds first. The configured command is:

```bash
npm run dist:portable
```

It uses `electron-builder` with the `portable` target and writes artifacts to
`release/`, which is ignored by git.

The script sets `CSC_IDENTITY_AUTO_DISCOVERY=false` and the Windows builder
configuration sets `signAndEditExecutable: false`. This intentionally skips
code signing for local unsigned builds and avoids `winCodeSign` extraction
errors on Windows accounts that cannot create symbolic links.

The build uses `asarUnpack` for the bundled SoundFont, alphaSynth script, and
`sqlite3` native module:

```text
dist/renderer/soundfonts/**/*
dist/renderer/vendor/alphasynth/**/*
node_modules/sqlite3/**/*
```

`npmRebuild` is currently disabled because this local Windows environment uses
the already installed `sqlite3` N-API binding. If the native dependency set
changes, verify `npm run dist:dir` before publishing portable builds.

## Bundled Audio Assets

The SF2 engine uses these local assets:

```text
public/vendor/alphasynth/alphaSynth.min.js
public/soundfonts/midiSound-2025-1-14.sf2
```

The user has confirmed that alphaSynth is open source and the bundled SF2 file
is authorized for this project. Keep future SoundFont changes documented here
and avoid replacing the file without confirming redistribution rights.

## Roadmap

- Import local MIDI files.
- Improve the playback engine abstraction.
- Improve numbered notation rendering.
- Add staff notation rendering.
- Add piano keyboard playback visualization.
- Improve soundfont-backed audio quality and fallback behavior.
- Add offline MP3 rendering and timeline mapping.
- Package desktop releases.

## Contributing

This project is intentionally small at the moment. Keep changes scoped,
typed, and easy to review. Prefer improving the foundation before adding broad
feature surfaces.

Before opening a pull request, run:

```bash
npm run typecheck
npm run build
```

## License

MIT
