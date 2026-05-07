# alphaSynth + SF2 接入开发计划

本文档描述在 `midi-studio` 中接入 v3 本地 `alphaSynth + SF2` 播放架构，并新增设置页面与 SQLite 持久化的第一阶段开发计划。目标是支持用户在“纯 MIDI/基础合成”和“SF2 合成”两种播放模式之间切换，用真实 SoundFont MIDI 合成改善音色，同时保留现有 React + Electron 工程结构、MIDI 解析、简谱同步和进度条能力。

> 当前实现状态：第一阶段已经落地。代码已包含 alphaSynth 播放器、SF2 资源、Electron 自定义资源协议、设置页、SQLite 持久化、主音量接入和播放模式切换竞态保护。本文档保留设计背景，同时标注实际实现与原计划差异。

## 1. 背景

当前 `midi-studio` v1 使用 `src/renderer/lib/synthPlayer.ts` 中的 Web Audio 振荡器直接生成音色。优点是依赖少、实现轻，但声音不自然，主要问题包括：

- 音色是简单波形，没有钢琴采样的击弦、衰减、释放和共鸣特征。
- MIDI 控制器、Program Change、Velocity 曲线、延音踏板等信息基本没有被真实还原。
- 复音混合、释放尾音和 seek 后的状态恢复都需要手写调度，风险较高。

v3 `midi-gui-player-v3` 已验证可使用本地资源完成浏览器内 MIDI 合成：

```text
C:\Users\Trivedi\projects\midi-gui-player-v3\assets\alphaSynth.min.js
C:\Users\Trivedi\projects\midi-gui-player-v3\assets\midiSound-2025-1-14.sf2
```

用户已确认 `alphaSynth` 为开源，SF2 已有授权。本阶段可以把这套音频架构迁入工程化项目。

## 2. 目标

- 使用 `alphaSynth` 加载本地 `.sf2` SoundFont 播放 MIDI。
- 保留现有本地 MIDI 打开流程，并把原始 MIDI `ArrayBuffer` 交给 alphaSynth。
- 播放状态、当前位置、结束状态由 alphaSynth 事件驱动。
- 继续支持播放、暂停、停止、seek、速度调整和进度条。
- 继续用现有 `@tonejs/midi` 解析结果驱动简谱高亮，不在本阶段实现五线谱映射。
- 保留当前纯合成播放器作为开发期 fallback 或调试后备。
- 新增设置页面，允许用户切换播放模式：
  - `basic-midi`：纯 MIDI/基础合成模式，沿用当前轻量 Web Audio 合成器。
  - `sf2-synth`：SF2 合成模式，使用 alphaSynth 加载本地 SoundFont。
- 使用 SQLite 保存用户设置，数据库放在 exe 同级 `data` 目录内；portable 版本优先使用 `PORTABLE_EXECUTABLE_DIR` 解析真实 portable exe 所在目录。

## 3. 不做范围

- 不在本阶段实现五线谱渲染。
- 不在本阶段实现离线 MP3/WAV 导出。
- 不在本阶段实现完整轨道混音、左右手分离、移调、踏板可视化。
- 不在本阶段引入服务端渲染或后端音频管线。
- 不在本阶段做复杂偏好项管理，只保存播放引擎模式和少量基础播放器设置。

## 4. v3 可迁移点

v3 的关键初始化逻辑：

```js
const settings = new alphaSynth.Settings();
settings.soundFont = "assets/midiSound-2025-1-14.sf2";
settings.bufferTimeInMilliseconds = 1000;
settings.logLevel = alphaSynth.LogLevel.None;
const synth = new alphaSynth.AlphaSynthApi(settings);
```

关键事件：

- `ready`：alphaSynth worker/output 初始化完成。
- `soundFontLoaded`：SF2 加载完成，可以加载 MIDI。
- `midiLoaded`：MIDI 文件加载完成，可以播放。
- `positionChanged`：返回 `currentTime`、`endTime`、`currentTick`、`endTick`，其中时间为毫秒。
- `stateChanged`：播放器状态变化，v3 中 `event.state === 1` 表示播放中。
- `finished`：播放完成。
- `soundFontLoadFailed` / `midiLoadFailed`：加载失败。

关键控制 API：

- `loadMidiFile(arrayBuffer | Uint8Array | string)`
- `play()`
- `pause()`
- `stop()`
- `setTimePosition(ms)`
- `setPlaybackSpeed(speedRatio)`
- `setMasterVolume(volume)`
- `setPlaybackRange(startTick, endTick)`
- `setIsLooping(enabled)`
- `destroy()`

## 5. 推荐架构

新增统一播放器接口，把 UI 从具体播放器实现中解耦：

```ts
export type PlayerStatus =
  | "idle"
  | "loading-soundfont"
  | "loading-midi"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export type PlayerSnapshot = {
  status: PlayerStatus;
  positionMs: number;
  durationMs: number;
  loadingMessage?: string;
  error?: string;
};

export interface MidiPlaybackEngine {
  load(input: {
    midiBytes: ArrayBuffer;
    notes: MidiNote[];
    durationMs: number;
  }): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  stop(): void;
  seek(positionMs: number): void;
  setSpeed(percent: number): void;
  dispose(): void;
  getSnapshot(): PlayerSnapshot;
  subscribe(listener: (snapshot: PlayerSnapshot) => void): () => void;
}
```

建议文件结构：

```text
src/renderer/lib/player/
  types.ts
  synthPlayer.ts
  alphaSynthPlayer.ts
  createPlayer.ts
src/renderer/features/settings/
  SettingsPage.tsx
  settingsTypes.ts
src/renderer/types/
  alphaSynth.d.ts
src/main/settings/
  settingsDb.ts
  settingsService.ts
src/main/resources/
  resourceProtocol.ts
public/vendor/alphasynth/
  alphaSynth.min.js
public/soundfonts/
  midiSound-2025-1-14.sf2
```

说明：

- `synthPlayer.ts` 从当前 `src/renderer/lib/synthPlayer.ts` 迁入，作为 fallback。
- `alphaSynthPlayer.ts` 封装 `window.alphaSynth.AlphaSynthApi`，不让 React 组件直接碰全局对象。
- `createPlayer.ts` 根据持久化设置切换 `sf2-synth` / `basic-midi`。
- `settingsDb.ts` 负责创建 exe 同级 `data/midi-studio.sqlite3` 和数据库迁移，生产 portable 环境优先使用 `process.env.PORTABLE_EXECUTABLE_DIR`。
- `settingsService.ts` 负责设置读写、默认值合并和 IPC handler。
- `resourceProtocol.ts` 注册 `midi-studio-resource://assets/...`，统一开发和 portable 资源加载路径。
- `public/` 资源会被 Vite 复制到 renderer 根路径，但 renderer 不直接 import 这些文件；运行时通过 Electron 自定义协议读取白名单资源。

## 6. 设置页与持久化设计

### 6.1 设置项

第一版设置只保留和播放体验直接相关的稳定字段：

```ts
export type PlaybackEngineMode = "basic-midi" | "sf2-synth";

export type UserSettings = {
  playbackEngineMode: PlaybackEngineMode;
  defaultSpeedPercent: number;
  masterVolumePercent: number;
  followPlayback: boolean;
};
```

默认值：

```ts
const DEFAULT_SETTINGS: UserSettings = {
  playbackEngineMode: "sf2-synth",
  defaultSpeedPercent: 100,
  masterVolumePercent: 100,
  followPlayback: true
};
```

说明：

- `playbackEngineMode` 是本阶段最关键设置。
- `sf2-synth` 作为默认值，优先使用真实 SoundFont 音色。
- 如果 alphaSynth 或 SF2 加载失败，UI 可以提示用户切换到 `basic-midi`，也可以提供一次性 fallback，但不自动改写用户设置。

### 6.2 设置页面

设置页建议采用应用内视图，不打开独立系统窗口。第一版入口放在顶部或侧栏：

- 主界面增加“设置”按钮。
- 设置页面包含一个播放器模式分段控件：
  - `纯 MIDI`
  - `SF2 合成`
- 展示当前数据库位置，便于用户确认 portable 数据目录。
- 设置更新通过 renderer 侧队列串行保存到 SQLite，避免滑块或分段按钮快速操作时旧请求覆盖新状态。
- 若当前已有 MIDI 曲目，保存后先创建并加载新播放器；只有新播放器加载成功且当前 MIDI 未变化时才替换旧播放器。

UI 行为：

- `basic-midi`：不加载 alphaSynth/SF2，启动更快，音色较简单。
- `sf2-synth`：加载 alphaSynth 和 SoundFont，音色更自然，首次加载有等待时间。
- 保存失败时在页面内展示错误，不静默吞掉。

### 6.3 SQLite 位置

用户要求数据库放在 exe 同级 `data` 目录：

```text
midi-studio-0.1.0-portable.exe
data/
  midi-studio.sqlite3
```

生产环境路径：

```ts
const appDir = app.isPackaged
  ? process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(process.execPath)
  : process.cwd();
const dataDir = path.join(appDir, "data");
const dbPath = path.join(dataDir, "midi-studio.sqlite3");
```

开发环境路径建议：

```text
C:\Users\Trivedi\projects\midi-studio\data\midi-studio.sqlite3
```

原因：

- 开发环境没有最终 exe，使用项目根目录 `data` 最直观。
- 生产环境优先使用 `PORTABLE_EXECUTABLE_DIR`，符合 electron-builder portable target 的真实 exe 目录；如果该变量不存在，再 fallback 到 `path.dirname(process.execPath)`。

注意：

- 如果用户把 exe 放在无写权限目录，SQLite 初始化会失败，需要提示“当前目录不可写，请移动到可写目录后重试”。
- `data/` 需要加入 `.gitignore`，避免本地数据库被提交。

### 6.4 SQLite schema

第一版使用简单 key-value 表，便于后续扩展设置项：

```sql
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

初始化时写入：

```text
app_meta.schema_version = 1
```

设置值统一 JSON 序列化，读取时与 `DEFAULT_SETTINGS` 合并。这样新增设置项不需要立即迁移老数据库。

### 6.5 Electron IPC 边界

SQLite 只在 main process 中访问，renderer 不直接拿 Node.js 或文件系统能力。

preload 暴露最小 API：

```ts
window.midiStudio.settings.get(): Promise<UserSettings>;
window.midiStudio.settings.update(patch: Partial<UserSettings>): Promise<UserSettings>;
window.midiStudio.settings.getStorageInfo(): Promise<{
  dataDir: string;
  dbPath: string;
}>;
```

main process 注册 handler：

```ts
ipcMain.handle("settings:get", ...)
ipcMain.handle("settings:update", ...)
ipcMain.handle("settings:storage-info", ...)
```

renderer 启动流程：

1. `App` 启动后读取 settings。
2. 根据 `playbackEngineMode` 创建播放器。
3. 用户在设置页切换模式后保存 SQLite。
4. 如果已有曲目，先创建新播放器并 load 当前 MIDI bytes。
5. 新播放器 load 完成后校验当前 MIDI input、加载代际和当前播放器仍未变化。
6. 校验通过后再释放旧播放器并替换为新播放器；校验失败或加载失败时 dispose 临时播放器并保留旧播放器。

## 7. 资源加载策略

### 7.1 alphaSynth 脚本

实际方案：renderer 在需要 `sf2-synth` 时动态插入脚本标签，脚本 URL 走 Electron 自定义协议。

```ts
const ALPHASYNTH_SCRIPT_URL =
  "midi-studio-resource://assets/vendor/alphasynth/alphaSynth.min.js";
```

优点：

- 不把 alphaSynth UMD 文件 import 进 Vite bundle。
- 不从 renderer source 直接 import `public/` 文件，避免 Vite public 资源检查。
- 开发环境和 portable 构建使用同一条资源路径。
- 避免先处理 UMD 包的 TypeScript/Vite 打包细节。
- alphaSynth 自身会创建 worker/audio worklet，脚本 URL 更稳定。

脚本加载失败后会清空缓存 promise 并移除失败标签，允许用户切换模式或重新加载时再次尝试。

如果 SF2 加载失败或超时，`AlphaSynthPlayer` 会记录错误、清空 ready 状态、销毁当前 synth 实例；下一次 load 会清理旧错误并重建 synth，允许用户在资源恢复后重试。

后续方案：若确认 npm 包或源码包可稳定使用，再改为依赖安装和 ESM/worker 集成。

### 7.2 SF2 文件

放入：

```text
public/soundfonts/midiSound-2025-1-14.sf2
```

运行时路径：

```ts
const soundFontUrl =
  "midi-studio-resource://assets/soundfonts/midiSound-2025-1-14.sf2";
```

Electron production 中，Vite 会把 public 内容复制到 `dist/renderer/`。当前 electron-builder `files` 已包含 `dist/**/*`，因此 portable 包会带上 SF2。`asarUnpack` 也显式包含 `dist/renderer/soundfonts/**/*` 与 `dist/renderer/vendor/alphasynth/**/*`。

## 8. package.json 影响

alphaSynth/SF2 本身不需要新增 npm 运行时依赖，因为 v3 使用的是本地 `alphaSynth.min.js` UMD 文件。

SQLite 持久化需要新增依赖。用户明确要求使用 `sqlite3`，建议：

```json
{
  "dependencies": {
    "sqlite3": "^5.x"
  }
}
```

SQLite 相关注意事项：

- `sqlite3` 是 native module，Electron 打包时需要匹配 Electron ABI。
- `electron-builder` 默认会处理 native dependency rebuild，但需要在 Windows portable 打包前验证 `dist:dir`。
- 如果安装或 rebuild 失败，优先检查 Node 16、Electron 25、npm registry 镜像和 Visual Studio Build Tools 环境。
- 当前 Windows 环境缺少完整 Windows SDK 时，打包期 rebuild 会失败；可先用 `npm rebuild sqlite3` 安装 N-API binding，并在 electron-builder 中设置 `npmRebuild: false` 与 `asarUnpack` 复用该 binding。
- 不把 sqlite 数据库放进 `asar`，数据库只在运行时创建到 exe 同级 `data/`。

需要检查或可能调整：

- `build.files` 当前包含 `dist/**/*`，只要资源进入 `dist/renderer` 就会被打进 portable 包。
- `package-lock.json` 会因为新增 `sqlite3` 变化。
- 不建议把 `.sf2` 放在 `src/` 后通过 import 打包，避免 Vite 对大二进制资源生成 hash 路径后影响 alphaSynth worker 内部加载。
- 如果后续 SF2 文件增大，需要评估 Git LFS 或 release asset；当前约 2.8 MB，可以直接纳入仓库，但需要在 README 标明授权来源。
- `.gitignore` 需要新增 `data/`。

建议新增但本阶段可后置：

- `license` 或 `NOTICE` 中记录 alphaSynth 与 SF2 授权说明。
- README 增加 SoundFont 来源与授权段落。

## 9. 实施步骤

### Phase 1: 资产迁移与类型声明

- 从 v3 复制 `alphaSynth.min.js` 到 `public/vendor/alphasynth/`。
- 从 v3 复制 `midiSound-2025-1-14.sf2` 到 `public/soundfonts/`。
- 通过 `midi-studio-resource://assets/vendor/alphasynth/alphaSynth.min.js` 动态加载 alphaSynth 脚本。
- 新增 `src/renderer/types/alphaSynth.d.ts`，声明最小可用 API。
- 更新 README/AGENTS，说明本地 SoundFont 资源、授权前提、自定义协议和 SQLite 数据目录。

验收：

- `npm run build` 后 `dist/renderer/vendor/alphasynth/alphaSynth.min.js` 存在。
- `npm run build` 后 `dist/renderer/soundfonts/midiSound-2025-1-14.sf2` 存在。
- TypeScript 不再需要 `any` 大面积泄漏到 UI 层。

### Phase 2: SQLite 设置存储

- 安装 `sqlite3`。
- 新增 `src/main/settings/settingsDb.ts`：
  - 解析 `dataDir` / `dbPath`。
  - 创建 `data/` 目录。
  - 打开 `midi-studio.sqlite3`。
  - 执行 schema 初始化。
- 新增 `src/main/settings/settingsService.ts`：
  - 读取设置并合并默认值。
  - 更新部分设置。
  - 返回存储路径信息。
- 在 main process 注册 IPC handlers。
- 在 preload 暴露 `window.midiStudio.settings`。
- `.gitignore` 新增 `data/`。

验收：

- 开发环境启动后生成 `data/midi-studio.sqlite3`。
- 设置读写可跨重启保持。
- renderer 无法直接访问 sqlite，只能通过 preload API。
- `npm run typecheck` 通过。

### Phase 3: 设置页面

- 新增设置页面或设置面板。
- 增加播放模式选择：
  - `纯 MIDI`
  - `SF2 合成`
- 显示数据库路径和数据目录。
- 切换后保存 SQLite，并让播放器工厂重新创建对应引擎。
- 保存失败时显示错误。

验收：

- 用户可以切换模式并立即保存。
- 重启应用后模式保持。
- 切换模式不会丢失当前 UI 基本状态；如当前曲目需要重载，给出明确提示。

### Phase 4: 播放器抽象

- 抽出 `MidiPlaybackEngine`、`PlayerSnapshot`、`PlayerStatus`。
- 将当前 `SynthPlayer` 移到 `src/renderer/lib/player/synthPlayer.ts`。
- App 只依赖统一接口，不直接依赖具体播放器类。
- `createPlayer(settings.playbackEngineMode)` 根据设置创建播放器。
- 保持当前 UI 行为不变。

验收：

- `basic-midi` 模式下，现有纯合成播放仍可用。
- `play/pause/stop/seek/speed` 行为不回退。
- `npm run typecheck` 通过。

### Phase 5: alphaSynthPlayer 实现

- 创建 `AlphaSynthPlayer`。
- 初始化时设置：
  - `soundFont = "midi-studio-resource://assets/soundfonts/midiSound-2025-1-14.sf2"`
  - `bufferTimeInMilliseconds = 1000`
  - `logLevel = alphaSynth.LogLevel.None`
- `load()` 中保存 MIDI 原始 bytes，等待 `soundFontLoaded` 后调用 `loadMidiFile()`。
- `midiLoaded` 后进入 `ready` 状态，并更新总时长。
- `positionChanged` 驱动 `positionMs` 和进度条。
- `stateChanged` 同步 `playing/paused`。
- `finished` 设置 `ended`，并保持或归零位置需要和当前 UI 行为一致。
- `setSpeed(percent)` 映射到 `setPlaybackSpeed(percent / 100)`。
- `seek(positionMs)` 映射到 `setTimePosition(positionMs)`。

验收：

- 导入 MIDI 后能等待 SF2/MIDI 就绪再播放。
- 播放音色来自 SF2，不再是 triangle oscillator。
- 拖动进度条后声音和简谱高亮保持同步。
- 变速后声音速度和进度条一致。
- 设置为 `sf2-synth` 时使用 alphaSynth；设置为 `basic-midi` 时不加载 alphaSynth。

### Phase 6: UI 状态与错误处理

- UI 增加加载状态展示：
  - `音源加载中`
  - `MIDI 加载中`
  - `音源加载失败`
  - `MIDI 加载失败`
- 播放按钮在 `ready/paused/playing/ended` 状态可用。
- 未 ready 时点击播放给出明确提示，不直接失败。
- 加载新曲目时重置速度、位置、错误状态。

验收：

- SF2 路径错误时 UI 有明确错误。
- MIDI 加载失败时不会卡在 disabled 状态。
- 切换曲目不会沿用上一首的播放速度和状态。

### Phase 7: 打包验证

- 运行 `npm run typecheck`。
- 运行 `npm run build`。
- 检查 `dist/renderer` 下的 vendor 与 soundfont 文件。
- 运行 `npm run dist:dir`，用 unpacked 目录版验证资源路径。
- 验证 unpacked 目录旁可创建 `data/midi-studio.sqlite3`。
- 验证 portable exe 同级可创建 `data/midi-studio.sqlite3`。
- 用户明确要求时再运行 `npm run dist:portable`。

验收：

- 开发环境和生产构建都能加载 alphaSynth 和 SF2。
- portable 包中包含 SF2。
- 用户设置在 portable exe 重启后仍然保留。
- Windows 不出现 `winCodeSign` symlink 权限问题。

## 10. 风险与应对

### 10.1 alphaSynth worker 脚本路径

alphaSynth 会根据当前脚本路径创建 worker/audio worklet。如果脚本被打包进 JS chunk，路径可能失效。

应对：

- 第一版通过 `midi-studio-resource://assets/vendor/alphasynth/alphaSynth.min.js` 动态加载脚本。
- 不把 alphaSynth 交给 Vite bundle。

### 10.2 Electron file/protocol 资源加载

Electron renderer 在 dev/prod 中分别运行在 `http://127.0.0.1:5173` 和打包后的 renderer 页面下，普通相对资源 URL 容易出现差异。

应对：

- 已采用 Electron 自定义协议 `midi-studio-resource://assets/...`。
- main process 只白名单开放 alphaSynth JS 和当前 SF2 文件，避免暴露任意本地路径。
- dev 环境从 `public/` 读取，production 从 `dist/renderer/` 读取。
- 用 `dist:dir` 先验证 unpacked 目录。

### 10.3 大文件纳入 Git

SF2 当前约 2.8 MB，可接受；后续高质量 SoundFont 可能明显变大。

应对：

- 当前文件可直接纳入仓库。
- 若后续超过几十 MB，改为 release asset 或可选下载。

### 10.4 状态双来源

现有 UI 使用 `@tonejs/midi` 解析出的时间轴，alphaSynth 使用内部 MIDI 解析播放。两者在复杂 tempo map 中可能存在少量差异。

应对：

- 当前继续用 `@tonejs/midi` 结果做简谱显示，用 alphaSynth `positionChanged.currentTime` 做当前时间源。
- 若发现 tempo map 差异，再把解析统一到同一 MIDI 数据模型或引入 tick/time 映射校准。

### 10.5 浏览器后台/窗口失焦

alphaSynth 使用 worker + Web Audio，理论上比主线程定时器稳定，但 UI 更新仍可能被节流。

应对：

- 声音播放以 alphaSynth 为准。
- UI 只订阅 `positionChanged` 并节流渲染。
- Electron 中后续可设置窗口/电源相关策略，但本阶段先验证实际表现。

### 10.6 sqlite3 native module 打包

`sqlite3` 需要 native binding，和纯 JS 依赖不同。开发环境能跑不代表 portable 包一定能跑。

应对：

- 先做 `npm run dist:dir`，直接运行 `release/win-unpacked/midi-studio.exe` 验证。
- 确认 `node_modules/sqlite3` 的 native binding 被 electron-builder 正确处理。
- 若 portable 中失败，优先尝试 `electron-builder install-app-deps` 或检查 rebuild 日志。
- SQLite 数据文件放在 `data/`，不放进 asar，不需要 asar 解包。

### 10.7 exe 同级目录权限

如果 exe 位于受保护目录，应用可能无法创建 `data/`。

应对：

- 初始化失败时显示明确错误。
- 设置页展示当前数据目录。
- README 提醒 portable exe 建议放在用户可写目录。

### 10.8 播放模式切换时的状态一致性

用户播放中切换 `basic-midi` / `sf2-synth`，可能导致旧播放器未释放或当前曲目状态丢失。

应对：

- 切换模式时先创建临时新播放器，并使用保存的原始 MIDI bytes 重新 load。
- 新播放器 load 期间保存 load generation、当前 MIDI input 和当前播放器引用。
- load 完成后再次校验这些 token，避免用户同时打开新 MIDI 时被旧切换流程覆盖。
- 只有新播放器加载并校验成功后，才 dispose 旧播放器并替换引用。
- 重建后 seek 回切换前的位置。
- 如果 SF2 模式加载失败，dispose 临时播放器、保留旧播放器，并回滚持久化播放模式后提示错误。

## 11. 第一版完成定义

- 项目包含本地 alphaSynth 和 SF2 资源。
- 新增设置页面，支持选择 `纯 MIDI` / `SF2 合成`。
- 用户设置保存到 exe 同级 `data/midi-studio.sqlite3`。
- 默认播放引擎为 `AlphaSynthPlayer`，但用户可以切换回基础合成。
- 纯合成 `SynthPlayer` 仍保留为 `basic-midi` 模式。
- 本地 MIDI 文件可导入、播放、暂停、停止、seek、调速。
- 简谱高亮和进度条跟随 alphaSynth 时间轴。
- `npm run typecheck` 与 `npm run build` 通过。
- README 说明 SoundFont/alphaSynth 授权与 portable 打包注意事项。
