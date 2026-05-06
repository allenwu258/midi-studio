# alphaSynth + SF2 接入开发计划

本文档描述在 `midi-studio` 中接入 v3 本地 `alphaSynth + SF2` 播放架构的第一阶段开发计划。目标是用真实 SoundFont MIDI 合成替换当前纯 `OscillatorNode` 合成，同时保留现有 React + Electron 工程结构、MIDI 解析、简谱同步和进度条能力。

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

## 3. 不做范围

- 不在本阶段实现五线谱渲染。
- 不在本阶段实现离线 MP3/WAV 导出。
- 不在本阶段实现完整轨道混音、左右手分离、移调、踏板可视化。
- 不在本阶段引入服务端渲染或后端音频管线。

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
src/renderer/types/
  alphaSynth.d.ts
public/vendor/alphasynth/
  alphaSynth.min.js
public/soundfonts/
  midiSound-2025-1-14.sf2
```

说明：

- `synthPlayer.ts` 从当前 `src/renderer/lib/synthPlayer.ts` 迁入，作为 fallback。
- `alphaSynthPlayer.ts` 封装 `window.alphaSynth.AlphaSynthApi`，不让 React 组件直接碰全局对象。
- `createPlayer.ts` 后续用于切换 `alphasynth` / `basic-synth`。
- `public/` 资源会被 Vite 复制到 renderer 根路径，开发和生产都可通过相对 URL 请求。

## 6. 资源加载策略

### 6.1 alphaSynth 脚本

短期方案：在 `index.html` 中加载本地脚本。

```html
<script src="/vendor/alphasynth/alphaSynth.min.js"></script>
```

优点：

- 与 v3 行为一致。
- 避免先处理 UMD 包的 TypeScript/Vite 打包细节。
- alphaSynth 自身会创建 worker/audio worklet，脚本 URL 更稳定。

后续方案：若确认 npm 包或源码包可稳定使用，再改为依赖安装和 ESM/worker 集成。

### 6.2 SF2 文件

放入：

```text
public/soundfonts/midiSound-2025-1-14.sf2
```

运行时路径：

```ts
const soundFontUrl = "/soundfonts/midiSound-2025-1-14.sf2";
```

Electron production 中，Vite 会把 public 内容复制到 `dist/renderer/`。当前 electron-builder `files` 已包含 `dist/**/*`，因此 portable 包会带上 SF2。

## 7. package.json 影响

当前计划不需要新增 npm 运行时依赖，因为 v3 使用的是本地 `alphaSynth.min.js` UMD 文件。

需要检查或可能调整：

- `build.files` 当前包含 `dist/**/*`，只要资源进入 `dist/renderer` 就会被打进 portable 包。
- `package-lock.json` 不需要变化，除非后续改用 npm 版 alphaSynth。
- 不建议把 `.sf2` 放在 `src/` 后通过 import 打包，避免 Vite 对大二进制资源生成 hash 路径后影响 alphaSynth worker 内部加载。
- 如果后续 SF2 文件增大，需要评估 Git LFS 或 release asset；当前约 2.8 MB，可以直接纳入仓库，但需要在 README 标明授权来源。

建议新增但本阶段可后置：

- `license` 或 `NOTICE` 中记录 alphaSynth 与 SF2 授权说明。
- README 增加 SoundFont 来源与授权段落。

## 8. 实施步骤

### Phase 1: 资产迁移与类型声明

- 从 v3 复制 `alphaSynth.min.js` 到 `public/vendor/alphasynth/`。
- 从 v3 复制 `midiSound-2025-1-14.sf2` 到 `public/soundfonts/`。
- 在 `index.html` 加载 alphaSynth 脚本。
- 新增 `src/renderer/types/alphaSynth.d.ts`，声明最小可用 API。
- 更新 README/AGENTS，说明本地 SoundFont 资源和授权前提。

验收：

- `npm run build` 后 `dist/renderer/vendor/alphasynth/alphaSynth.min.js` 存在。
- `npm run build` 后 `dist/renderer/soundfonts/midiSound-2025-1-14.sf2` 存在。
- TypeScript 不再需要 `any` 大面积泄漏到 UI 层。

### Phase 2: 播放器抽象

- 抽出 `MidiPlaybackEngine`、`PlayerSnapshot`、`PlayerStatus`。
- 将当前 `SynthPlayer` 移到 `src/renderer/lib/player/synthPlayer.ts`。
- App 只依赖统一接口，不直接依赖具体播放器类。
- 保持当前 UI 行为不变。

验收：

- 不启用 alphaSynth 时，现有纯合成播放仍可用。
- `play/pause/stop/seek/speed` 行为不回退。
- `npm run typecheck` 通过。

### Phase 3: alphaSynthPlayer 实现

- 创建 `AlphaSynthPlayer`。
- 初始化时设置：
  - `soundFont = "/soundfonts/midiSound-2025-1-14.sf2"`
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

### Phase 4: UI 状态与错误处理

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

### Phase 5: 打包验证

- 运行 `npm run typecheck`。
- 运行 `npm run build`。
- 检查 `dist/renderer` 下的 vendor 与 soundfont 文件。
- 运行 `npm run dist:dir`，用 unpacked 目录版验证资源路径。
- 用户明确要求时再运行 `npm run dist:portable`。

验收：

- 开发环境和生产构建都能加载 alphaSynth 和 SF2。
- portable 包中包含 SF2。
- Windows 不出现 `winCodeSign` symlink 权限问题。

## 9. 风险与应对

### 9.1 alphaSynth worker 脚本路径

alphaSynth 会根据当前脚本路径创建 worker/audio worklet。如果脚本被打包进 JS chunk，路径可能失效。

应对：

- 第一版用 `public/vendor/alphasynth/alphaSynth.min.js` 加 `<script>` 直连。
- 不把 alphaSynth 交给 Vite bundle。

### 9.2 Electron file/protocol 资源加载

生产环境中页面从 `file://.../dist/renderer/index.html` 加载，相对资源路径必须可解析。

应对：

- 优先使用绝对根路径 `/soundfonts/...` 在 Vite dev 中验证。
- 若 Electron production 下根路径不稳定，则改为相对路径 `./soundfonts/...`，并通过 `new URL()` 统一生成。
- 用 `dist:dir` 先验证 unpacked 目录。

### 9.3 大文件纳入 Git

SF2 当前约 2.8 MB，可接受；后续高质量 SoundFont 可能明显变大。

应对：

- 当前文件可直接纳入仓库。
- 若后续超过几十 MB，改为 release asset 或可选下载。

### 9.4 状态双来源

现有 UI 使用 `@tonejs/midi` 解析出的时间轴，alphaSynth 使用内部 MIDI 解析播放。两者在复杂 tempo map 中可能存在少量差异。

应对：

- 当前继续用 `@tonejs/midi` 结果做简谱显示，用 alphaSynth `positionChanged.currentTime` 做当前时间源。
- 若发现 tempo map 差异，再把解析统一到同一 MIDI 数据模型或引入 tick/time 映射校准。

### 9.5 浏览器后台/窗口失焦

alphaSynth 使用 worker + Web Audio，理论上比主线程定时器稳定，但 UI 更新仍可能被节流。

应对：

- 声音播放以 alphaSynth 为准。
- UI 只订阅 `positionChanged` 并节流渲染。
- Electron 中后续可设置窗口/电源相关策略，但本阶段先验证实际表现。

## 10. 第一版完成定义

- 项目包含本地 alphaSynth 和 SF2 资源。
- 默认播放引擎为 `AlphaSynthPlayer`。
- 纯合成 `SynthPlayer` 仍保留为 fallback。
- 本地 MIDI 文件可导入、播放、暂停、停止、seek、调速。
- 简谱高亮和进度条跟随 alphaSynth 时间轴。
- `npm run typecheck` 与 `npm run build` 通过。
- README 说明 SoundFont/alphaSynth 授权与 portable 打包注意事项。

