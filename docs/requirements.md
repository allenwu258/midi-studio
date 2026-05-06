# midi-studio 需求文档

本文档描述 `midi-studio` 的第一阶段产品需求。需求基于 piastudy 乐谱页
`https://piastudy.com/Intermediate/oeRHt0dR` 的 MIDI 播放、五线谱渲染、实时同步、
导出与交互能力整理，并结合本项目 React + Electron 的本地桌面定位做了取舍。

## 1. 背景

piastudy 的乐谱页提供了一套在线钢琴谱播放体验：页面加载五线谱 SVG、MIDI 文件、
音符空间映射 JSON，并在播放过程中同步高亮五线谱、滚动谱面、显示键盘按键和播放进度。
用户可以调速、移调、循环片段、开关节拍器、缩放谱面、打印或下载乐谱。

`midi-studio` 的目标是把这类体验工程化为一个本地优先的开源桌面应用，优先支持本地
MIDI 文件和本地导出，后续再扩展在线资源导入。

## 2. 产品目标

- 支持导入 MIDI 文件并稳定播放。
- 支持五线谱渲染，并和 MIDI 播放时间轴保持同步。
- 支持播放过程中的音符高亮、当前小节/系统定位、自动跟随滚动。
- 支持钢琴键盘实时可视化。
- 支持调速、移调、循环、节拍器、缩放等练习控制。
- 支持导出音频、乐谱图片/PDF、同步映射数据。
- 在 Electron 桌面端避免浏览器标签页后台节流导致的卡顿和爆音。

## 3. 参考页面观察

### 3.1 页面技术结构

piastudy 页面使用 Astro + Svelte island 方式渲染，核心播放器组件为 `ScoreCont`。
页面在 HTML 中直接注入 `sheetData`、`imgList`、推荐列表等 props。

核心乐谱数据字段包括：

| 字段 | 含义 |
| --- | --- |
| `sheetCode` | 乐谱唯一编码。 |
| `title` / `songName` | 展示标题和曲名。 |
| `artist` / `author` / `compose` | 艺术家、上传者、作曲信息。 |
| `keynote` | 原调，如 `Bb`。 |
| `difficulty` / `difficultyName` | 难度编码与难度名。 |
| `pagesCount` | PC 版页数。 |
| `mobilePagesCount` | 移动版页数。 |
| `imageType` | 谱面图片类型，参考页为 `svg`。 |
| `imagePathUrl` | PC 版谱面 SVG 根路径。 |
| `mobileImagePath` | 移动版谱面 SVG 根路径。 |
| `midiUrl` | MIDI 文件 URL。 |
| `spaceUrl` | PC 版同步映射 JSON URL。 |
| `mobileSpaceUrl` | 移动版同步映射 JSON URL。 |
| `scoreUrl` | 平台内部乐谱源文件 URL。 |

### 3.2 渲染资源模型

参考页采用三类资源协同工作：

- `*.mid`：实际播放数据。
- `sheetImg/{page}.svg`：五线谱页面，SVG 内包含可定位音符元素。
- `space.json`：时间轴到谱面坐标、音符 ID、键盘音高的映射。

`space.json` 的核心结构可抽象为：

```ts
type ScoreSpaceMap = {
  timesTamp: PageTimestamp[];
  notesPositionInfo: PagePositionInfo[];
};

type PageTimestamp = {
  startTime: number;
  systemTimesTamp: SystemTimestamp[];
};

type SystemTimestamp = {
  startTime: number;
  noteTimestamp: NoteTimestamp[];
};

type NoteTimestamp = {
  startTime: number;
  notesInfo: Array<{
    noteName: string;
    startTime: number;
  }>;
};

type PagePositionInfo = {
  starTime: number;
  length: number;
  systemPositionInfo: SystemPositionInfo[];
};

type SystemPositionInfo = {
  starTime: number;
  systemLeft: number;
  systemTop: number;
  systemWidth: number;
  systemHeight: number;
  noteTimestamp: NotePosition[];
};

type NotePosition = {
  noteName: string;
  starTime: number;
  noteLeft: number;
  noteWidth: number;
  key?: Array<number[] | null>;
  notesInfo?: Array<{ endTime: number }>;
  tieEnd?: boolean;
};
```

说明：

- `noteName` 对应 SVG 中的音符元素 ID 或可定位标识。
- `starTime/startTime` 使用毫秒时间。
- `systemLeft/systemTop/systemWidth/systemHeight` 和 `noteLeft/noteWidth` 为相对坐标，
  适合随谱面缩放重算高亮位置。
- `key` 包含 MIDI 音高数组，可驱动钢琴键盘按下动画。
- `tieEnd` 用于处理延音线结束音等特殊显示。

## 4. 用户角色

- 练习者：导入曲目、播放、降速、循环片段、跟谱练习。
- 制谱/调试者：查看 MIDI、谱面、同步映射是否准确。
- 内容整理者：批量导出音频、PDF、同步数据，建立本地曲库。

## 5. 功能需求

### 5.1 曲目导入

#### 必须支持

- 从本地选择 `.mid` / `.midi` 文件。
- 解析 MIDI 基本信息：曲名、轨道、拍号、调号、BPM、总时长、音符事件。
- 生成内部曲目对象，保存最近打开记录。
- 对无法解析或无音符事件的文件给出明确错误状态。

#### 后续支持

- 导入 MusicXML / `.mxl`。
- 导入 piastudy 类资源包：MIDI + SVG 页图 + space JSON。
- 从 URL 拉取远端资源并缓存到本地。

### 5.2 MIDI 播放

#### 必须支持

- 播放、暂停、停止、回到开头。
- 拖动进度条跳转到任意时间。
- 显示当前时间和总时长，格式为 `mm:ss`。
- 播放状态在 UI 中即时反映。
- 支持播放结束后自动停止并复位播放状态。

#### 音频质量要求

- 默认使用 SoundFont 或采样器播放，而不是浏览器默认震荡器音色。
- 调度必须基于音频时钟，不依赖 `setTimeout` 精确触发每个音。
- 播放前应预调度短时间窗口内的音符事件，降低 UI 卡顿造成的爆音。
- Electron 环境下后台窗口仍应保持稳定播放。

### 5.3 五线谱渲染

#### 必须支持

- 将 MIDI 转换为可阅读的钢琴五线谱视图。
- 支持多页或连续滚动布局。
- 支持谱面缩放，范围参考 `50% - 200%`。
- 支持当前播放位置的纵向跟随滚动。
- 支持按页加载，避免大曲目一次性渲染造成卡顿。

#### 渲染策略

第一阶段允许两种模式并存：

- 标准渲染模式：从 MIDI/MusicXML 生成五线谱。
- 映射渲染模式：加载已有 SVG 谱面和 `space.json`，获得接近 piastudy 的精准同步体验。

### 5.4 实时同步

#### 必须支持

- 当前播放音符在五线谱上高亮。
- 当前系统或小节显示半透明跟随光标。
- 当前时间进入下一系统时自动滚动到可视区域中部。
- 拖动进度条后，高亮与滚动位置同步更新。
- 暂停后保持当前位置高亮。
- 停止后清除高亮并回到起点。

#### 同步精度

- 音频播放和 UI 时间轴误差目标小于 `50ms`。
- 拖动进度条后的视觉刷新目标小于 `100ms`。
- 自动滚动不应抢夺用户手动滚动；用户滚动后应短暂暂停自动跟随。

### 5.5 钢琴键盘

#### 必须支持

- 显示 88 键钢琴键盘。
- MIDI 播放时实时点亮按下的键。
- 支持左右手或轨道分色，若 MIDI 轨道信息足够。
- 支持隐藏/显示键盘。

#### 参考页面行为

参考页从 `space.json` 的 `key` 字段提取 MIDI 音高数组，并触发键盘按键动画。
本项目可优先从 MIDI note-on/note-off 事件驱动键盘，再在映射模式下使用 `space.json`
校正显示。

### 5.6 播放控制

#### 必须支持

- 播放/暂停。
- 停止/回到开头。
- 进度条拖动。
- 调速，范围参考 `10% - 200%`，默认 `100%`。
- 缩放，范围参考 `50% - 200%`，默认 `100%`。
- 移调，目标调支持 `C, C#, Db, D, Eb, E, F, F#, Gb, G, Ab, A, Bb, B, Cb`。
- 循环播放，支持设置循环起点和终点。
- 节拍器开关。
- 空格键播放/暂停。

#### 后续支持

- 左手/右手单独静音。
- 单手练习。
- 倒计时进入。
- A-B 循环拖拽手柄。

### 5.7 导出

#### 必须支持

- 导出当前曲目的 MIDI 副本。
- 导出当前谱面为 PDF。
- 导出当前谱面页面为 PNG 或 SVG。
- 导出同步映射 JSON。

#### 音频导出

- 支持离线渲染为 MP3。
- 支持离线渲染为 WAV，作为无损中间产物。
- 导出时应用当前设置：移调、速度、声源、音量。
- 导出完成后给出保存路径和文件大小。

#### 时间轴导出

导出 MP3 时必须同时生成时间轴映射文件：

```ts
type ExportTimelineMap = {
  audioFile: string;
  durationMs: number;
  tempoScale: number;
  transpose: number;
  events: Array<{
    timeMs: number;
    noteIds: string[];
    midiKeys: number[];
    pageIndex?: number;
    systemIndex?: number;
    x?: number;
    y?: number;
  }>;
};
```

该映射用于播放已渲染 MP3 时仍能驱动五线谱高亮和钢琴键盘动画。

### 5.8 打印

- 支持打印完整谱面。
- 打印时使用白底、无播放器 UI、按页面分页。
- 支持打印前预览。
- 无谱面时禁用打印按钮。

### 5.9 曲库与历史

- 保存最近打开文件列表。
- 保存每首曲目的上次播放位置。
- 保存用户常用设置：速度、缩放、键盘显示、节拍器开关。
- 支持清除历史记录。

## 6. 界面需求

### 6.1 主界面布局

桌面端采用三栏或两栏工作台布局：

- 左侧：曲目列表、文件导入、曲目信息。
- 中间：五线谱主阅读区。
- 底部：播放控制条和进度条。
- 下方或可折叠区域：钢琴键盘。
- 右侧可选：导出、轨道、设置、同步调试面板。

### 6.2 播放控制条

控制条固定在窗口底部，包含：

- 播放/暂停按钮。
- 停止按钮。
- 当前时间 / 总时长。
- 进度滑条。
- 缩放入口。
- 键盘显示入口。
- 移调入口。
- 循环入口。
- 调速入口。
- 节拍器入口。
- 导出入口。

### 6.3 视觉要求

- 整体风格保持简洁、工具型、低干扰。
- 谱面区域应有最高视觉优先级。
- 播放高亮颜色必须清晰但不遮挡音符。
- 循环区间标记应可见，并与当前播放光标区分。
- 小屏窗口下控制条可折叠次要功能。

## 7. 技术需求

### 7.1 模块划分

建议模块：

```text
src/
  main/
    export/          离线导出、文件保存、原生对话框
    library/         本地曲库索引
  preload/
    api.ts           暴露安全 IPC API
  renderer/
    app/
    features/
      player/
      score/
      keyboard/
      export/
      library/
    shared/
```

### 7.2 播放引擎

播放引擎需要提供统一接口：

```ts
interface PlaybackEngine {
  load(song: SongProject): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  seek(timeMs: number): void;
  setSpeed(percent: number): void;
  setTranspose(semitones: number): void;
  setLoop(range: LoopRange | null): void;
  setMetronome(enabled: boolean): void;
  onTick(listener: (state: PlaybackState) => void): () => void;
  onNote(listener: (event: PlaybackNoteEvent) => void): () => void;
}
```

### 7.3 谱面渲染器

谱面渲染器需要提供统一接口：

```ts
interface ScoreRenderer {
  load(project: SongProject): Promise<void>;
  render(container: HTMLElement): Promise<void>;
  highlight(noteIds: string[]): void;
  showCursor(position: ScoreCursorPosition): void;
  clearHighlight(): void;
  scrollTo(timeMs: number, behavior?: ScrollBehavior): void;
  setScale(percent: number): void;
  print(): Promise<void>;
}
```

### 7.4 同步服务

同步服务负责 MIDI 时间、音频时间、谱面位置、键盘音高之间的映射：

```ts
interface TimelineSyncService {
  getActiveNotes(timeMs: number): ActiveNote[];
  getCursor(timeMs: number): ScoreCursorPosition | null;
  getKeyboardKeys(timeMs: number): number[];
  getPageIndex(timeMs: number): number;
  exportMap(): ExportTimelineMap;
}
```

### 7.5 数据模型

```ts
type SongProject = {
  id: string;
  title: string;
  sourceType: "midi" | "musicxml" | "mapped-score";
  midiFile?: LocalFileRef;
  scorePages?: ScorePage[];
  spaceMap?: ScoreSpaceMap;
  metadata: SongMetadata;
  settings: SongPlaybackSettings;
};

type SongMetadata = {
  artist?: string;
  composer?: string;
  arranger?: string;
  key?: string;
  difficulty?: string;
  durationMs?: number;
};

type SongPlaybackSettings = {
  speedPercent: number;
  transposeSemitones: number;
  showKeyboard: boolean;
  metronomeEnabled: boolean;
  scalePercent: number;
};
```

## 8. 非功能需求

### 8.1 性能

- 10 分钟以内 MIDI 文件导入解析目标小于 `2s`。
- 播放时 UI 主线程不能长时间阻塞，单帧任务目标小于 `16ms`。
- 谱面滚动和高亮目标 `60fps`，最低不低于 `30fps`。
- 大谱面按页懒加载。

### 8.2 稳定性

- 播放不应因窗口失焦、最小化、后台运行产生明显节奏漂移。
- 音频调度和 UI 渲染解耦。
- 导出任务失败时不影响当前工程状态。
- 所有文件写入通过 Electron 主进程完成。

### 8.3 安全

- Renderer 不直接启用 Node.js。
- 保持 `contextIsolation: true` 和 `nodeIntegration: false`。
- 文件系统能力只通过 preload 暴露明确 API。
- 远程资源导入需要用户确认。

### 8.4 可测试性

- MIDI 解析、时间轴同步、循环区间、速度变更应有单元测试。
- 渲染器至少保留可替换接口，便于测试同步逻辑而不依赖真实 DOM。
- 导出流程需要覆盖成功、取消、失败三类路径。

## 9. 里程碑

### M1 基础曲目播放

- 本地 MIDI 导入。
- SoundFont 播放。
- 播放/暂停/停止/seek。
- 时间显示和进度条。

### M2 五线谱与键盘

- MIDI 到五线谱初版渲染。
- 当前音符高亮。
- 钢琴键盘实时显示。
- 自动跟随滚动。

### M3 练习控制

- 调速。
- 移调。
- A-B 循环。
- 节拍器。
- 设置持久化。

### M4 导出

- 导出 MIDI。
- 导出 PDF/图片。
- 离线渲染 WAV/MP3。
- 导出 MP3 时间轴映射。

### M5 映射谱面模式

- 支持 SVG + space JSON + MIDI 资源包导入。
- 使用映射数据精准定位音符与系统。
- 支持打印映射谱面。

## 10. 暂不实现

- 用户账号、云同步、社区、推荐列表。
- 在线购买或会员权限。
- 平台版权资源下载绕过。
- 移动端 Web 版本。
- 实时录音评测和跟弹打分。

## 11. 验收标准

- 用户能导入一个本地 MIDI 文件并正常播放。
- 播放过程中时间、进度条、键盘和五线谱位置同步。
- 用户能调速、移调、循环并听到正确结果。
- 用户能导出 MP3，并获得可用于同步高亮的时间轴 JSON。
- 应用在 Electron 中运行时，切换到其他应用不会出现明显卡顿或爆音。
- `npm run typecheck` 和 `npm run build` 通过。

## 12. 参考资料

- piastudy 示例页面：`https://piastudy.com/Intermediate/oeRHt0dR`
- 页面观察到的核心组件：`/assets/ScoreCont.9b0d5529.js`
- 示例资源类型：MIDI、SVG 谱面、`space.json` 同步映射
