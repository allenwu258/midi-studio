# Staff Notation Pipeline Development Plan

本文档是 `codex/staff-notation-pipeline` 分支的功能开发规划，覆盖：

- MIDI 转五线谱结构化模型。
- 五线谱渲染。
- 播放位置到乐谱位置的映射。
- MusicXML 导出预留。
- 移除当前内联的暴力简谱 UI。

详细算法背景见：

```text
docs/midi-to-staff-notation-technical-design.md
```

## 当前状态

当前播放器链路：

```text
MIDI file
  -> parseMidiFile()
  -> ParsedSong.notes
  -> player load/playback
  -> ParsedSong.clusters
  -> App inline NumberedNotation
```

主要文件：

```text
src/renderer/lib/midi.ts
src/renderer/lib/notation.ts
src/renderer/App.tsx
src/renderer/styles.css
```

当前简谱耦合点：

- `src/renderer/lib/notation.ts`
  - `midiToNumberedNotation()`
  - `normalizeKeyName()`
  - `formatTime()`
- `src/renderer/lib/midi.ts`
  - `MidiNote.notation`
  - `NoteCluster`
  - `ParsedSong.clusters`
  - `createNoteClusters()`
- `src/renderer/App.tsx`
  - `NumberedNotation`
  - `NoteToken`
  - `findClusterPlayback()`
  - panel label uses `aria-label="简谱"`
  - title uses `简谱 MIDI 播放器`
- `src/renderer/styles.css`
  - `.numbered-score`
  - `.note-token`

目标不是只替换 UI，而是把解析、结构化乐谱、渲染、播放定位拆成清晰模块。

## 目标用户体验

用户打开 MIDI 后，主界面显示五线谱工作区：

```text
sidebar metadata / import diagnostics
main staff notation viewport
bottom transport
```

播放时：

- 当前音符或当前 chord 在五线谱上高亮。
- 已播放区域有轻量状态。
- 拖动底部进度条时，五线谱定位同步到对应小节/音符。
- 点击乐谱上的音符、和弦或小节区域，可以 seek 到对应播放位置。

第一版不追求专业排版软件质量，但必须做到：

- 小节、拍号、谱号、休止、音符时值基本正确。
- 播放映射稳定。
- 比当前简谱更接近真实练习场景。

## 总体架构

新增五层管线：

```text
Raw MIDI bytes
  -> ParsedSong
  -> ScoreDraft
  -> RenderScore
  -> StaffNotationView
  -> PlaybackPositionMap
```

模块职责：

```text
src/renderer/lib/midi.ts
  MIDI 读取、播放用 note 数据、meta 数据。不能再负责简谱显示。

src/renderer/lib/score/
  MIDI 到五线谱结构模型。纯数据、纯算法、可测试。

src/renderer/lib/staff/
  将 ScoreDraft 转换成渲染布局模型。包含坐标、系统、小节、音符 glyph 信息。

src/renderer/features/notation/
  React 五线谱组件、交互、高亮、滚动。

src/renderer/lib/playbackMap/
  音频位置 ms 与 ScoreDraft/RenderScore 元素之间的双向映射。
```

## 新增目录规划

```text
src/renderer/lib/score/
  fraction.ts
  types.ts
  options.ts
  normalize.ts
  measureMap.ts
  chords.ts
  quantize.ts
  durations.ts
  pitchSpelling.ts
  createScoreDraft.ts
  diagnostics.ts
  index.ts

src/renderer/lib/staff/
  types.ts
  layout.ts
  glyphs.ts
  renderGeometry.ts
  index.ts

src/renderer/lib/playbackMap/
  types.ts
  buildPlaybackMap.ts
  lookup.ts
  index.ts

src/renderer/features/notation/
  StaffNotationPanel.tsx
  StaffSystem.tsx
  StaffMeasure.tsx
  StaffGlyph.tsx
  useAutoScrollToPlayback.ts
  notationStyles.css
```

可选后续：

```text
src/renderer/lib/score/musicxml.ts
src/renderer/lib/score/voices.ts
src/renderer/lib/score/pianoSplit.ts
src/renderer/lib/score/tuplets.ts
```

## 数据模型

### ParsedSong 调整

`ParsedSong` 保留播放需要的数据，同时移除简谱专属字段：

```ts
export type ParsedSong = {
  id: string;
  fileName: string;
  title: string;
  keyName: string;
  bpm: number | null;
  durationMs: number;
  trackCount: number;
  noteCount: number;
  notes: MidiNote[];
  meta: ParsedMidiMeta;
};
```

`MidiNote` 移除 `notation`：

```ts
export type MidiNote = {
  id: string;
  midi: number;
  name: string;
  startMs: number;
  durationMs: number;
  endMs: number;
  velocity: number;
  trackIndex: number;
  trackName: string;
  startTicks: number;
  durationTicks: number;
  endTicks: number;
  channel?: number;
  program?: number;
};
```

新增 meta：

```ts
export type ParsedMidiMeta = {
  ppq: number;
  tempos: Array<{ ticks: number; bpm: number }>;
  timeSignatures: Array<{ ticks: number; numerator: number; denominator: number }>;
  keySignatures: Array<{ ticks: number; key: string; scale?: string }>;
};
```

### ScoreDraft

`ScoreDraft` 是五线谱的源数据，不包含像素坐标：

```ts
export type ScoreDraft = {
  id: string;
  title: string;
  ppq: number;
  parts: ScorePart[];
  measures: ScoreMeasure[];
  diagnostics: ScoreDiagnostic[];
};
```

关键元素必须有稳定 id：

```ts
export type ScoreElementId = string;
```

稳定 id 用于：

- React key。
- 播放高亮。
- 点击 seek。
- 后续 MusicXML element trace。

### RenderScore

`RenderScore` 是布局模型：

```ts
export type RenderScore = {
  width: number;
  systems: RenderSystem[];
  elementBoxes: Map<ScoreElementId, RenderBox>;
};
```

每个 note/chord/rest/measure 都应有 bounding box。第一版可以用 SVG 坐标。

### Playback Map

播放映射是独立索引：

```ts
export type PlaybackMapEntry = {
  elementId: ScoreElementId;
  partId: string;
  staffIndex: number;
  voiceIndex: number;
  measureIndex: number;
  startMs: number;
  endMs: number;
  startTicks: number;
  endTicks: number;
  kind: "note" | "chord" | "rest" | "measure";
};
```

查询接口：

```ts
export function findActiveScoreElements(
  map: PlaybackMapEntry[],
  positionMs: number
): ActiveScorePosition;

export function findSeekPositionForElement(
  map: PlaybackMapEntry[],
  elementId: ScoreElementId
): number | null;
```

## 五线谱渲染策略

第一版建议自研轻量 SVG 渲染，而不是马上引入 OSMD/Verovio：

- 当前目标是练习播放器，不是完整制谱编辑器。
- 自研轻量渲染更容易做播放高亮和位置映射。
- SVG DOM 元素天然支持 bounding box、点击和 class 高亮。
- 后续仍可用 MusicXML 对接 OSMD 做高质量预览。

第一版渲染范围：

- Treble clef / bass clef。
- 5 条线 staff。
- 小节线。
- 4/4、3/4、6/8 等常见拍号文字。
- quarter / half / whole / eighth / sixteenth 基础音符头、符干、休止符占位。
- ledger lines。
- 简单 chord 垂直叠放。
- tie 可以先用 bezier 曲线。

符号来源：

- 第一版可以使用文本 glyph 或简化 SVG path。
- 不引入完整 SMuFL 字体前，符头/符干/小节线可用 SVG primitives。
- 后续再引入 Bravura/SMuFL 以改善专业观感。

布局策略：

```text
measure width = base width + note density weight
system width = viewport width - padding
wrap measures into systems
staff y = system y + staff offset
x position = measure x + proportional beat position
y position = staff middle line - pitch step * halfLineSpace
```

第一版重点是稳定和可映射，不追求复杂碰撞避让。

## 播放位置映射完整流程

### 构建阶段

```text
ParsedSong.notes
  -> ScoreDraft events keep source note ids and tick ranges
  -> RenderScore stores element boxes by elementId
  -> PlaybackMap stores ms/tick ranges by elementId
```

`ScoreDraft` 中每个 note/chord 应保留源 MIDI note ids：

```ts
sourceNoteIds: string[]
```

如果一个 MIDI note 被拆成多个 tied notation segments：

- 每个 segment 都有独立 `elementId`。
- 所有 segment 共享同一个 `sourceNoteId`。
- PlaybackMap 中每个 segment 的 `startMs/endMs` 按 tick 比例切分。

### 播放时查询

每 33ms snapshot 更新时：

1. 用 binary search 找到 positionMs 对应 entries。
2. 返回 active chord/note ids。
3. StaffNotationPanel 给 SVG elements 加 active/past class。
4. `useAutoScrollToPlayback` 根据 active element box 滚动。

### 点击乐谱 seek

1. SVG element `data-score-element-id`。
2. click handler 查 PlaybackMap。
3. `seekTo(entry.startMs)`。

### 进度条 seek 后同步

现有 `seekTo(value)` 保持。
StaffNotationPanel 只订阅 snapshot.positionMs，不直接持有播放器。

## 移除暴力简谱计划

### 第一步：并行接入 StaffNotationPanel

保留旧简谱一小段时间，但不再作为主实现。

`App.tsx`：

- title 改为 `MIDI 五线谱播放器` 或 `MIDI 练习工作台`。
- `aria-label="五线谱"`。
- 用 `StaffNotationPanel` 替换 `NumberedNotation`。

### 第二步：删除简谱 UI

删除：

- `NumberedNotation`
- `NoteToken`
- `findClusterPlayback`
- `NoteCluster` 类型
- `ParsedSong.clusters`
- `MidiNote.notation`
- `createNoteClusters`
- `.numbered-score`
- `.note-token`

### 第三步：拆分 notation.ts

保留 `formatTime()`，但改名或迁移到：

```text
src/renderer/lib/time.ts
```

删除 numbered notation 相关：

- `KEY_TO_PITCH_CLASS`
- `MAJOR_SCALE`
- `DEGREE_LABELS`
- `normalizeKeyName`
- `midiToNumberedNotation`

调号解析迁移到：

```text
src/renderer/lib/score/keySignature.ts
```

## 开发阶段

### Phase 1: 数据基础与简谱解耦

目标：

- `midi.ts` 输出 ticks/meta。
- 删除解析阶段的简谱字段。
- 新增 `ScoreDraft` 最小模型。
- UI 替换为 StaffNotationPanel 空壳。

任务：

1. 扩展 `ParsedSong`，增加 `meta` 和 tick 字段。
2. 新增 `src/renderer/lib/time.ts`，迁移 `formatTime()`。
3. 新增 `score` 类型和 fraction 工具。
4. 新增 `createScoreDraft()`，先输出单 part、单 staff、单 voice。
5. 新增 `StaffNotationPanel`，先渲染空状态和 diagnostics。
6. 从 `App.tsx` 移除 `NumberedNotation` 入口。

验收：

- `npm run typecheck` 通过。
- 打开 MIDI 后仍能播放。
- 主面板不再出现简谱 token。

### Phase 2: 基础五线谱渲染

目标：

- 生成小节。
- 渲染 staff lines、measure bars、clef、time signature。
- 渲染基础音符位置。

任务：

1. `measureMap.ts` 支持默认 4/4 和 MIDI 拍号。
2. `pitchSpelling.ts` 支持 C major / MIDI key signature。
3. `layout.ts` 把 ScoreDraft 转 RenderScore。
4. `StaffSystem/StaffMeasure/StaffGlyph` 渲染 SVG。
5. CSS 使用现有安静工具风格。

验收：

- 单轨 C 大调旋律能显示在五线谱上。
- 多小节可换行。
- resize 后布局不重叠。

### Phase 3: 量化、时值与休止

目标：

- 最短音符 1/16 量化。
- 生成 rests。
- 跨小节音符生成 tie。

任务：

1. `quantize.ts` 实现 nearest-grid baseline。
2. `durations.ts` 实现 whole/half/quarter/eighth/16th 和附点。
3. 每个 voice 填满 measure duration。
4. 渲染 rest 占位和 tie。

验收：

- 每小节 duration 校验通过。
- 跨小节长音在显示上有 tie。
- 休止符不再显示为空洞时间。

### Phase 4: 播放映射与交互

目标：

- 播放高亮五线谱元素。
- 乐谱点击 seek。
- 自动滚动到当前播放区域。

任务：

1. `buildPlaybackMap.ts` 从 ScoreDraft 构建映射。
2. `lookup.ts` 实现 binary search。
3. Staff SVG 元素绑定 `data-score-element-id`。
4. App 将 `snapshot.positionMs` 传给 StaffNotationPanel。
5. StaffNotationPanel 将 click 转换为 `onSeek(ms)`。
6. 实现 auto-scroll，跟随设置中的 follow playback。

验收：

- 播放时当前 note/chord 高亮。
- 拖动进度条后高亮跳到对应小节。
- 点击音符后播放器 seek 到该位置。

### Phase 5: 多轨、多谱表与基础钢琴

目标：

- 多 track 渲染为多 part 或多 staff。
- 钢琴 track 可拆成 grand staff baseline。

任务：

1. Track -> part 映射。
2. Program/name/channel 显示。
3. Treble/bass clef 选择。
4. Piano auto split 初版：pitch threshold。
5. 多 staff vertical layout。

验收：

- 多轨 MIDI 不再混成一条谱。
- 钢琴 MIDI 可显示双谱表。
- 播放高亮在多谱表仍正确。

### Phase 6: MusicXML 导出预留

目标：

- 从 ScoreDraft 导出基础 MusicXML。
- 后续可接 OSMD 或外部验证。

任务：

1. `musicxml.ts` 输出 score-partwise。
2. 支持 part-list、measure、attributes、note/rest、voice、staff、tie。
3. 添加开发期导出按钮或调试入口。

验收：

- 导出的 MusicXML 可被 MuseScore 打开。
- 每小节 duration 正确。

### Phase 7: 高级质量

目标：

- tuplets。
- 动态规划量化。
- 声部分离。
- 钢琴 DP 左右手拆分。

任务：

1. Triplet detection。
2. DP quantization。
3. Voice separation。
4. Piano split DP。
5. Import options UI。

验收：

- 三连音 MIDI 能识别为 tuplet。
- 真人轻微偏移 MIDI 可合理吸附。
- 简单复调能显示两个 voice。

## UI 设计原则

保持当前桌面工具风格：

- 不做 landing page。
- 不做装饰性大图。
- 主界面以乐谱工作区为第一屏。
- 控件紧凑、可扫描。
- 诊断信息放 sidebar，不在乐谱区域写大段说明。

新增 UI 区域：

```text
sidebar:
  song metadata
  import quality
  diagnostics
  score options summary

main:
  staff notation SVG viewport

footer:
  existing transport
```

## 技术风险

### 渲染质量风险

自研 SVG 第一版可能不如专业制谱软件。控制范围：

- 先做练习用可读谱。
- 不支持复杂排版编辑。
- MusicXML export 后续可交给专业渲染器。

### 算法复杂度风险

MIDI 转谱不存在唯一正确答案。控制范围：

- 第一版面向 clean MIDI。
- 对 human performance 做 diagnostics。
- 高级导入参数后置。

### 播放映射风险

一个 MIDI note 可能拆成多个 tie segment。控制范围：

- ScoreDraft 保留 source note ids。
- PlaybackMap 使用 element-level ms/tick range。
- 高亮 chord 与 note 两层都支持。

### 迁移风险

当前简谱逻辑在 `midi.ts` 和 `App.tsx` 内联。控制范围：

- 先引入 StaffNotationPanel，再删旧简谱。
- 播放引擎继续只依赖 `ParsedSong.notes`。
- 不让五线谱转换失败影响音频播放。

## 测试计划

### 必跑

```bash
npm run typecheck
npm run build
```

### UI 阶段必跑

```bash
npm run dev
```

并检查：

```text
http://127.0.0.1:5173
```

### 单元测试建议

当前项目没有测试框架。实现 score 算法时建议引入轻量测试策略：

- 如果不新增依赖，先用 TypeScript 编译期和小型 fixture validator。
- 后续考虑 Vitest，但需要确认 Node 16 兼容。

算法 fixture：

```text
fixtures/scale-c-major.mid
fixtures/rests-and-ties.mid
fixtures/dotted-rhythm.mid
fixtures/two-voices.mid
fixtures/piano-grand-staff.mid
fixtures/triplets.mid
```

## 代码审查检查清单

- 播放器 load/switch/dispose 顺序未被破坏。
- settings save queue 未被简化。
- renderer 仍不访问 Node API。
- 不从 `public/` import 资源。
- ScoreDraft 转换失败不会清空可播放 MIDI。
- 每个 SVG 乐谱元素有稳定 id。
- 每个 PlaybackMap entry 可反查 element box。
- 无新增大依赖，除非专门评估 Node 16 和打包体积。

## 初始实施顺序

建议这个分支接下来按以下 PR/commit 粒度推进：

1. `score-core`
   - Fraction、ScoreDraft types、ParsedSong meta/tick 扩展。
2. `remove-numbered-notation-shell`
   - StaffNotationPanel 空壳接入，删除简谱 UI。
3. `basic-staff-renderer`
   - SVG staff、measure、clef、基础 note。
4. `duration-and-rests`
   - 量化、休止、tie。
5. `playback-map`
   - 高亮、点击 seek、自动滚动。
6. `multi-staff`
   - 多轨和钢琴双谱表。
7. `musicxml-export`
   - 基础 MusicXML 导出。

## 本分支 Definition of Done

本分支完成时应满足：

- 原暴力简谱 UI 和解析字段已移除。
- 打开 MIDI 后显示五线谱工作区。
- clean MIDI 能显示基本小节、音符、休止和谱号。
- 播放时五线谱元素高亮。
- 点击五线谱元素可 seek。
- 拖动进度条后高亮同步。
- 播放、停止、速度、音量、播放引擎切换仍可用。
- `npm run typecheck` 通过。
- `npm run build` 通过。
