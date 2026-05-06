# midi-studio

midi-studio is an open-source desktop MIDI practice studio built with React,
Electron, Vite, and TypeScript.

The project is currently at the framework baseline stage. The app can install,
type-check, build, and launch, but MIDI playback, score rendering, soundfont
rendering, and timeline synchronization are intentionally not implemented yet.

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
| `npm run preview` | Serves the built renderer bundle locally. |
| `npm run typecheck` | Runs TypeScript checks for both renderer and Electron projects. |

## Project Layout

```text
midi-studio/
  src/
    main/       Electron main process
    preload/    Isolated bridge exposed to the renderer
    renderer/   React application
  index.html    Vite HTML entry
```

## Architecture Notes

- The renderer runs as a normal React application.
- The Electron main process owns the desktop window lifecycle.
- The preload script is the only bridge between the renderer and privileged
  Electron APIs.
- `contextIsolation` is enabled and `nodeIntegration` is disabled in the
  renderer window.
- Development loads the renderer from Vite.
- Production loads the built renderer from `dist/renderer/index.html`.

## Roadmap

- Import local MIDI files.
- Build a playback engine abstraction.
- Add notation rendering.
- Add piano keyboard playback visualization.
- Add soundfont-backed audio.
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
