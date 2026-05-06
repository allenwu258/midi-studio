# AGENTS.md

Guidance for coding agents working in this repository.

## Project

`midi-studio` is a React + Electron + Vite + TypeScript desktop application.
It is currently a clean scaffold for a future MIDI player and practice studio.
Do not add MIDI player features unless the user explicitly asks for them.

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

## Code Ownership

- `src/main/`: Electron main process and application lifecycle.
- `src/preload/`: Safe bridge between Electron and renderer.
- `src/renderer/`: React UI.
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

For UI changes, also launch:

```bash
npm run dev
```

Then verify the renderer at:

```text
http://127.0.0.1:5173
```

## Current Feature Boundary

The initial scaffold should remain feature-light. The next major work should be
planned before implementation, especially around:

- MIDI parsing.
- Audio playback architecture.
- Soundfont integration.
- Offline rendering.
- Score rendering.
- Timeline synchronization.

## Notes For Future Agents

- Read `README.md` before changing project structure.
- Preserve user changes in the working tree.
- Prefer small patches with clear verification.
- If a command fails because the dev server is already running, inspect the
  existing process before starting another one.
