# Staff Notation Pipeline Development Plan

本文档是当前 MusicXML / 五线谱分支的功能开发规划和实现记录，覆盖：

- MIDI 转五线谱结构化模型。
- 五线谱渲染。
- 播放位置到乐谱位置的映射。
- MusicXML 导入已完成，导出仍预留。
- 当前五线谱主链路、MusicXML 导入和后续 export 预留。

详细算法背景见：

```text
docs/midi-to-staff-notation-technical-design.md
```

## 当前状态

当前主链路已经从内联简谱原型迁移到五线谱管线：

```text
MIDI file
  -> midiParseWorker / parseMidiFile()
  -> ParsedSong.notes + ParsedSong.meta
  -> player load/playback
  -> scoreRenderWorker
  -> createScoreDraft()
  -> layoutScore()
  -> buildPlaybackMap()
  -> StaffNotationPanel
```

主要模块：

```text
src/renderer/lib/midi.ts
src/renderer/workers/midiParseWorker.ts
src/renderer/workers/scoreRenderWorker.ts
src/renderer/lib/score/
src/renderer/lib/staff/
src/renderer/lib/playbackMap/
src/renderer/features/notation/StaffNotationPanel.tsx
```

已落地能力：

- 简谱 UI 和旧的内联 numbered notation 主路径已移除。
- MIDI 解析和五线谱生成已搬到 Worker。
- MusicXML `.xml` / `.musicxml` / `.mxl` 导入已落地，解析与谱面建模在独立 Worker 内完成。
- MusicXML 导入会保留 source voice/staff、note type/dots、tuplet/time-modification、tie semantics 和 measure attributes。
- MusicXML 谱面直接进入 `ScoreDraft`，播放仍输出 MIDI bytes 交给 alphaSynth。
- `npm run validate:musicxml-fixtures` 已补齐，覆盖单声部、和弦、rest、backup/forward、多 voice、双谱表、tie、tempo、key/time change、tuplet 和 `.mxl`。
- `ScoreDraft` 包含小节、part、staff、voice、chord、rest、tie、tuplet 和 diagnostics。
- `RenderScore` 包含 system、measure、staff event、beam、tuplet、glyph boxes 和 element boxes。
- 播放映射支持当前音符高亮和点击乐谱 seek。
- 五线谱静态 SVG 与播放 overlay 分层，播放 clock 不再驱动 React 高频 rerender。
- Quantization 2.0 第一阶段已落地：小节级 beam search 同时考虑 start、duration、tuplet、tie/readability 和 voice hint。
- Duration spelling 复用 meter structure，note/rest 使用不同拆分策略。
- Piano split、voice split、spacing、beam、collision avoidance 均已有基础实现。

仍未完成或仍是预留：

- MusicXML 导出。
- 专业级 SMuFL 字体和完整 engraving solver。
- 钢琴键盘可视化。
- 离线 PDF/图片/音频导出。
- 更完整的 tuplet 类型、human performance import 和 fixture-driven penalty calibration。

## 目标用户体验

用户打开 MIDI 后，主界面显示五线谱工作区：

```text
sidebar metadata / import diagnostics
main staff notation viewport
bottom transport, locked by default
```

播放时：

- 当前音符或当前 chord 在五线谱上高亮。
- 已播放区域有轻量状态。
- 拖动底部进度条时，五线谱定位同步到对应小节/音符。
- 点击乐谱上的音符、和弦或小节区域，可以 seek 到对应播放位置。
- 底部播放栏默认固定在窗口底部，用户可通过图钉按钮取消锁定并恢复为页面底部栏。

第一版不追求专业排版软件质量，但必须做到：

- 小节、拍号、谱号、休止、音符时值基本正确。
- 播放映射稳定。
- 比早期简谱原型更接近真实练习场景。

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
  MIDI 读取、播放用 note 数据、meta 数据。不能承担谱面 UI 表示职责。

src/renderer/lib/score/
  MIDI 到五线谱结构模型。纯数据、纯算法、可测试。

src/renderer/lib/staff/
  将 ScoreDraft 转换成渲染布局模型。包含坐标、系统、小节、音符 glyph 信息。

src/renderer/features/notation/
  React 五线谱组件、交互、高亮、滚动。

src/renderer/lib/playbackMap/
  音频位置 ms 与 ScoreDraft/RenderScore 元素之间的双向映射。
```

## 目录规划与实际落地

```text
src/renderer/lib/score/
  types.ts
  measureMap.ts
  meterStructure.ts
  quantization.ts
  durations.ts
  rhythmSpelling.ts
  pitchSpelling.ts
  pianoSplit.ts
  voices.ts
  createScoreDraft.ts
  index.ts

src/renderer/lib/musicxml/
  parseMusicXml.ts
  toScoreDraft.ts
  toMidi.ts
  types.ts
  index.ts

src/renderer/workers/
  musicXmlParseWorker.ts

src/renderer/lib/staff/
  types.ts
  layout.ts
  spacing.ts
  glyphMetrics.ts
  beams.ts
  collisions.ts
  svgRenderer.ts
  legacySvgRenderer.ts
  svgExport.ts
  index.ts

src/renderer/lib/playbackMap/
  types.ts
  buildPlaybackMap.ts
  lookup.ts
  index.ts

src/renderer/features/notation/
  LegacyScoreSvg.tsx
  StaffNotationPanel.tsx
```

可选后续：

```text
src/renderer/lib/score/tuplets.ts
src/renderer/features/keyboard/
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

当前实现状态：

- `Classic JSX` 保留旧 React JSX 渲染路径，主要使用 ellipse/text 等 fallback 形状。
- `Engraved SVG` 是默认渲染模式，使用 `src/renderer/lib/staff/svgRenderer.ts` 输出
  统一 SVG markup，并由屏幕渲染和 `renderScoreToSvg(renderScore, rendererMode)` 共享。
- 设置页提供 `notationRendererMode` 持久化切换，首页侧栏显示当前渲染器名字。
- `scoreRenderWorker` 根据渲染模式选择 `DEFAULT_RENDER_LAYOUT_OPTIONS` 或
  `ENGRAVED_RENDER_LAYOUT_OPTIONS`，避免 layout 坐标和实际 renderer 常量错配。

符号来源：

- `Engraved SVG` 已把 notehead 从 ellipse fallback 替换为 SVG path，并统一 staff
  stroke、notehead、stem、beam、rest、clef、time signature 的基础比例。
- 谱号、休止符和临时记号仍依赖音乐字体/text glyph fallback。
- 后续再引入 Bravura/SMuFL 字体文件和真实 glyph metrics，以改善专业观感并减少平台字体差异。

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

## 简谱移除状态

暴力简谱主路径已经移除，当前不再需要保留并行简谱 UI。

已完成：

- `App.tsx` 主标题和主面板切换为五线谱播放器。
- `StaffNotationPanel` 成为主乐谱视图。
- 旧 `NumberedNotation` / `NoteToken` / cluster playback 查找逻辑已移除。
- `ParsedSong` 不再依赖 `clusters` 或 `MidiNote.notation` 作为显示模型。
- `formatTime()` 已迁移到 `src/renderer/lib/time.ts`。

后续如果需要简谱，应作为新的导出/显示模式单独设计，不应重新耦合进 MIDI 解析模型。

## 开发阶段

### Phase 1: 数据基础与简谱解耦（已完成）

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

### Phase 2: 基础五线谱渲染（已完成）

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

### Phase 3: 量化、时值与休止（已完成并进入 2.0 迭代）

目标：

- 最短音符 1/16 量化。
- 生成 rests。
- 跨小节音符生成 tie。

任务：

1. `quantization.ts` 实现 nearest-grid baseline，并已升级为小节级 beam search。
2. `durations.ts` 实现 whole/half/quarter/eighth/16th 和附点。
3. 每个 voice 填满 measure duration。
4. 渲染 rest 占位和 tie。

验收：

- 每小节 duration 校验通过。
- 跨小节长音在显示上有 tie。
- 休止符不再显示为空洞时间。

### Phase 4: 播放映射与交互（已完成基础链路）

目标：

- 播放高亮五线谱元素。
- 乐谱点击 seek。
- 自动滚动到当前播放区域。

任务：

1. `buildPlaybackMap.ts` 从 ScoreDraft 构建映射。
2. `lookup.ts` 实现 binary search。
3. Staff SVG 元素绑定 `data-score-element-id`。
4. App 暴露 playback clock getter，StaffNotationPanel 使用 overlay 低频读取，避免播放位置驱动 React 高频 rerender。
5. StaffNotationPanel 将 click 转换为 `onSeek(ms)`。
6. 实现 auto-scroll，跟随设置中的 follow playback。

验收：

- 播放时当前 note/chord 高亮。
- 拖动进度条后高亮跳到对应小节。
- 点击音符后播放器 seek 到该位置。

### Phase 5: 多轨、多谱表与基础钢琴（基础实现已完成）

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

### Engraved SVG 渲染器（基础实现已完成）

目标：

- 让谱面视觉从调试级 fallback 进入可阅读、专业感更强的 engraving baseline。
- 保留 `Classic JSX` 旧引擎作为设置项，不移除旧路径。
- 统一屏幕 SVG 和导出 SVG 的渲染源。

任务：

1. 新增 `src/renderer/lib/staff/svgRenderer.ts`，集中处理 Engraved SVG 的 body/style
   markup。
2. 新增 `LegacyScoreSvg.tsx` 和 `legacySvgRenderer.ts`，分别保留 classic 屏幕渲染和
   classic SVG export。
3. 新增 `notationRendererMode` 设置项，设置页可切换 `Engraved SVG` / `Classic JSX`。
4. `scoreRenderWorker` 接收 renderer mode，并使用匹配的 layout options。
5. `renderScoreToSvg(renderScore, rendererMode)` 显式接收渲染模式，避免导出路径错配。

验收：

- 设置页可切换渲染器，首页显示当前渲染器名字。
- Classic 模式仍输出 ellipse/text fallback。
- Engraved 模式不再输出 ellipse notehead，使用统一 notehead path。
- 两种模式都保留 `data-score-element-id`，播放高亮和点击 seek 不破坏。

### MusicXML 导入（已完成）

目标：

- 支持 `.xml` / `.musicxml` / `.mxl` 输入。
- 解析后直接生成 MusicXmlScoreSource、ScoreDraft 和播放用 MIDI bytes。
- 保留导入语义，不再先把 MusicXML 重新量化成通用 MIDI 再反推谱面。

任务：

1. `musicxml/parseMusicXml.ts` 负责解析和诊断。
2. `musicxml/toScoreDraft.ts` 直接构建谱面模型。
3. `musicxml/toMidi.ts` 负责播放侧 MIDI bytes。
4. `musicXmlParseWorker.ts` 保持解析和建模 off-main-thread。
5. `validate-musicxml-fixtures.mjs` 覆盖核心输入类型。

验收：

- MusicXML 导入后能显示五线谱并保持可播放。
- 导入诊断可见。
- 复杂输入不会破坏 MIDI 播放主链路。

### Phase 6: MusicXML 导出预留（未实现）

目标：

- 从 ScoreDraft 导出基础 MusicXML。
- 后续可接 OSMD 或外部验证。

任务：

1. 新增 MusicXML exporter 模块输出 `score-partwise`。
2. 支持 part-list、measure、attributes、note/rest、voice、staff、tie。
3. 添加开发期导出按钮或调试入口。

验收：

- 导出的 MusicXML 可被 MuseScore 打开。
- 每小节 duration 正确。

### Phase 7: 高级质量（进行中）

目标：

- tuplets。
- 动态规划量化。
- 声部分离。
- 钢琴 DP 左右手拆分。

任务：

1. Triplet detection。
2. 小节级 quantization beam search。
3. Voice split window search。
4. Piano split DP baseline。
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

简谱到五线谱的 UI 迁移已经完成。后续迁移风险主要来自算法质量提升时误伤播放链路。
控制范围：

- 播放引擎继续只依赖 `ParsedSong.notes` 和原始 MIDI bytes。
- MIDI 解析和五线谱生成继续在 Worker 中运行。
- 不让五线谱转换失败影响音频播放。
- 播放高亮继续走 playback map 和 overlay，不重新绑定到 React 高频 state。

## 测试计划

### 必跑

```bash
npm run typecheck
npm run build
npm run validate:score-fixtures
npm run validate:musicxml-fixtures
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

## 已完成实施顺序

这个分支已经按以下粒度完成基础链路：

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
7. `musicxml-import`
   - `parseMusicXmlFile()`、`MusicXmlScoreSource`、`toScoreDraft()`、`toMidi()` 和 fixture 校验已完成。
8. `musicxml-export`
   - 尚未实现，仍是下一阶段任务。

## 本分支 Definition of Done

本分支基础链路已满足：

- 原暴力简谱 UI 和解析字段已移除。
- 打开 MIDI 后显示五线谱工作区。
- clean MIDI 能显示基本小节、音符、休止和谱号。
- 播放时五线谱元素高亮。
- 点击五线谱元素可 seek。
- 拖动进度条后高亮同步。
- 播放、停止、速度、音量、播放引擎切换仍可用。
- `npm run typecheck` 通过。
- `npm run validate:score-fixtures` 通过。
- `npm run build` 通过。

剩余 DoD：

- MusicXML 导出。
- 更完整的 tuplet/human performance import。
- 更接近 MuseScore 的 engraving geometry。
