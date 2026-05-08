# MIDI to Staff Notation and MusicXML Technical Design

本文档基于 MuseScore Studio 本地源码调研，给出 `midi-studio` 可落地的
MIDI 逆向五线谱与 MusicXML 导出技术方案。

MuseScore 源码位置：

```text
C:\Users\Trivedi\projects\github-cloned\MuseScore
```

`midi-studio` 源码位置：

```text
C:\Users\Trivedi\projects\midi-studio
```

## 目标

当前 `midi-studio` 已有 MIDI 解析、播放、五线谱主视图和 alphaSynth + SF2 播放。
下一阶段如果要继续提升五线谱质量并实现 MusicXML，核心问题不是 XML 序列化，而是从
MIDI 演奏事件推断乐谱语义：

- 小节、拍号、弱起和速度结构。
- 和弦、休止、连音线、附点、切分、连桁和 tuplets。
- 复调声部和钢琴左右手谱表。
- 调号、谱号和音高拼写。
- 最后再导出 MusicXML 或交给五线谱渲染器显示。

本文档的落地目标是设计一个 TypeScript 版 ScoreDraft 管线，让
`midi-studio` 可以先支持干净 MIDI 的五线谱/MusicXML，再逐步逼近
MuseScore 的复杂导入质量。

## 关键结论

MuseScore 的 MIDI import 不是 `MIDI -> MusicXML` 直连，而是：

```text
MIDI file
  -> MidiFile / MidiTrack events
  -> import MIDI intermediate model: MTrack / MidiChord / MidiNote
  -> quantization, tuplets, voices, staves, clefs, keys, rests, ties
  -> engraving::Score
  -> optional MusicXML export from Score
```

对 `midi-studio` 来说，正确路线也应是：

```text
Parsed MIDI
  -> NormalizedMidiSong
  -> ScoreDraft
  -> StaffNotationModel
  -> MusicXML / Renderer
```

不要让 MIDI 解析器直接输出 MusicXML。中间模型是后续交互调参、五线谱渲染、
错误诊断和导出稳定性的关键。

## 当前实现进展

截至当前 `codex/staff-notation-pipeline` 分支，本文档中的核心 ScoreDraft 管线已经
部分落地，但 MusicXML 导出仍未实现。

已实现：

- `src/renderer/lib/midi.ts` 输出包含 tick、track、program、channel、tempo、拍号、
  调号的 `ParsedSong`。
- MIDI 解析已搬到 `midiParseWorker`。
- 五线谱生成已搬到 `scoreRenderWorker`。
- `src/renderer/lib/score/` 已包含：
  - `measureMap.ts`
  - `meterStructure.ts`
  - `quantization.ts`
  - `durations.ts`
  - `rhythmSpelling.ts`
  - `pitchSpelling.ts`
  - `pianoSplit.ts`
  - `voices.ts`
  - `createScoreDraft.ts`
- `ScoreDraft` 已支持 part、staff、voice、measure、chord、rest、tie、tuplet、
  diagnostics。
- Quantization 已从 nearest-grid baseline 升级为小节级 beam search，候选同时评分
  start、duration、tuplet、tie/readability、rest complexity 和 voice hint。
- 声部分离已实现 measure/window search，量化阶段的 voice hint 会作为后续搜索偏好。
- 钢琴双谱表拆分已实现 DP baseline。
- 五线谱渲染器已自研落地在 `src/renderer/lib/staff/`，包含 layout、spacing、
  glyph metrics、beams、collision avoidance 和 SVG export helper。
- `src/renderer/lib/playbackMap/` 已实现播放位置到乐谱元素的映射。

仍未实现或仍不完整：

- MusicXML exporter。
- 完整 Import Options UI。
- 5、6、7 等泛化 tuplet 和嵌套 tuplet。
- Human performance detection / beat adjustment。
- Pedal controller 转 pedal marks。
- SMuFL 字体和出版级 engraving solver。
- 用 MuseScore 对照 fixture 对 penalty 做系统校准。

## MuseScore 源码映射

MuseScore MIDI import 入口：

```text
src/importexport/midi/internal/notationmidireader.cpp
src/importexport/midi/internal/midiimport/importmidi.cpp
```

核心模块：

```text
src/importexport/midi/internal/midishared/midifile.cpp
src/importexport/midi/internal/midiimport/importmidi_inner.h
src/importexport/midi/internal/midiimport/importmidi_chord.h
src/importexport/midi/internal/midiimport/importmidi_chord.cpp
src/importexport/midi/internal/midiimport/importmidi_quant.cpp
src/importexport/midi/internal/midiimport/importmidi_meter.cpp
src/importexport/midi/internal/midiimport/importmidi_tuplet*.cpp
src/importexport/midi/internal/midiimport/importmidi_voice.cpp
src/importexport/midi/internal/midiimport/importmidi_lrhand.cpp
src/importexport/midi/internal/midiimport/importmidi_key.cpp
src/importexport/midi/internal/midiimport/importmidi_simplify.cpp
```

MusicXML 导出模块独立于 MIDI import：

```text
src/importexport/musicxml/internal/export/exportmusicxml.cpp
```

这说明 MuseScore 先生成自己的 `Score`，再由 MusicXML exporter 从 `Score`
遍历导出。`midi-studio` 也应先生成可渲染的乐谱模型，再由 exporter 写 XML。

## MuseScore MIDI Import 流水线

MuseScore 主流程在 `convertMidi()` 中完成，逻辑顺序可以概括为：

```text
read midi file
separate channel tracks
merge note-on and note-off
create MTrack list
lengthen too-short notes
detect chord names / lyrics
detect human performance
collect nearby notes into chords
adjust chords to detected beats
merge equal on-time chords
detect left/right hand split
remove overlapping same-pitch notes
split into left/right hand staves
split drum voices/tracks
detect tuplets
quantize chords
remove overlaps again
simplify durations
separate voices
split unequal-duration chords
create instruments and staves
create measures
process meta events
create keys
recognize key if needed
create notes, rests, ties, tuplets
apply swing
create clefs and time signatures
connect ties
set lyrics, tempo, chord names
```

这个顺序有几个重要工程含义：

- tuplets 必须在最终量化前识别，因为 tuplet 量化网格不同。
- 左右手拆分早于最终创建谱表，但晚于初步和弦聚合。
- 声部分离晚于量化和时值简化，因为 voice 冲突依赖最终时间。
- 创建 `Score` DOM 是最后阶段，不应在早期算法里频繁操作 UI/DOM 对象。

## 中间模型设计

MuseScore 的核心中间类型是 `MTrack`、`MidiChord`、`MidiNote`。`midi-studio`
建议引入对应的 TypeScript 模型，但命名上使用更贴近产品的 `ScoreDraft`。

### 输入模型

当前 `src/renderer/lib/midi.ts` 已经负责把 MIDI 解析成 normalized song。
新增转换管线应把它作为输入，不破坏现有播放器。

建议补充或派生以下输入结构：

```ts
export interface NormalizedMidiNote {
  trackIndex: number;
  channel: number;
  pitch: number;
  velocity: number;
  startTicks: number;
  endTicks: number;
  startSeconds: number;
  endSeconds: number;
}

export interface NormalizedMidiTrack {
  index: number;
  name: string;
  channel?: number;
  program?: number;
  isDrum: boolean;
  notes: NormalizedMidiNote[];
}

export interface NormalizedMidiMeta {
  ppq: number;
  tempos: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  keySignatures: KeySignatureEvent[];
}
```

如果当前 `@tonejs/midi` 提供的 tick 与 tempo 映射不足，应在 `midi.ts` 内保留
原始 PPQ、tempo、time signature、key signature 信息，避免后续只剩秒级时间。
五线谱算法必须以 tick/fraction 为主，秒级时间只用于播放同步。

### ScoreDraft

建议新增目录：

```text
src/renderer/lib/score/
```

核心文件：

```text
src/renderer/lib/score/types.ts
src/renderer/lib/score/createScoreDraft.ts
src/renderer/lib/score/quantization.ts
src/renderer/lib/score/meterStructure.ts
src/renderer/lib/score/rhythmSpelling.ts
src/renderer/lib/score/voices.ts
src/renderer/lib/score/pianoSplit.ts
src/renderer/lib/score/musicxml.ts
```

核心类型：

```ts
export interface ScoreDraft {
  ppq: number;
  divisions: number;
  parts: ScorePartDraft[];
  measures: MeasureDraft[];
  tempoMap: TempoEvent[];
  timeSignatureMap: TimeSignatureEvent[];
  keySignatureMap: KeySignatureEvent[];
  importOptions: MidiImportOptions;
  diagnostics: ImportDiagnostic[];
}

export interface ScorePartDraft {
  id: string;
  sourceTrackIndexes: number[];
  name: string;
  program?: number;
  isDrum: boolean;
  staves: StaffDraft[];
}

export interface StaffDraft {
  index: number;
  clef: Clef;
  voices: VoiceDraft[];
}

export interface VoiceDraft {
  index: number;
  events: VoiceEventDraft[];
}

export type VoiceEventDraft = ChordDraft | RestDraft;

export interface ChordDraft {
  kind: "chord";
  tick: Fraction;
  duration: Fraction;
  notationDurations: NotationDurationSegment[];
  notes: NoteDraft[];
  voice: number;
  staff: number;
  tupletId?: string;
  tieStart?: boolean;
  tieStop?: boolean;
  articulations?: Articulation[];
}

export interface NoteDraft {
  pitch: number;
  step?: "C" | "D" | "E" | "F" | "G" | "A" | "B";
  octave?: number;
  alter?: -2 | -1 | 0 | 1 | 2;
  velocity: number;
}

export interface RestDraft {
  kind: "rest";
  tick: Fraction;
  duration: Fraction;
  notationDurations: NotationDurationSegment[];
  voice: number;
  staff: number;
}
```

内部算法阶段可以使用更接近 MuseScore 的临时结构：

```ts
interface ImportTrack {
  sourceTrackIndex: number;
  program?: number;
  isDrum: boolean;
  hadInitialNotes: boolean;
  chords: MapByFraction<ImportChord>;
  tuplets: TupletDraft[];
}

interface ImportChord {
  onTime: Fraction;
  voice: number;
  staff: number;
  notes: ImportNote[];
  barIndex: number;
  tupletId?: string;
}

interface ImportNote {
  pitch: number;
  velocity: number;
  offTime: Fraction;
  originalOnTime: Fraction;
  offTimeQuant?: Fraction;
  tupletId?: string;
  staccato?: boolean;
}
```

注意：JavaScript `Map` 不能直接用对象 Fraction 做稳定 key。建议使用
`FractionKey = `${numerator}/${denominator}`` 或维护有序数组。由于量化和小节扫描
大量依赖时间排序，第一版建议用排序数组：

```ts
type ImportChordEvent = {
  onTime: Fraction;
  chord: ImportChord;
};
```

## Fraction 与 Tick 规范

MuseScore 使用 `ReducedFraction` 和内部 ticks。`midi-studio` 也应避免浮点时间。

建议实现不可变 Fraction：

```ts
export interface Fraction {
  n: number;
  d: number;
}
```

必备操作：

- `reduce(f)`
- `add(a, b)`
- `sub(a, b)`
- `mul(a, b | number)`
- `div(a, b | number)`
- `cmp(a, b)`
- `abs(a)`
- `fromTicks(ticks, divisions)`
- `toTicks(f, divisions)`
- `floorToGrid(value, grid, origin)`
- `ceilToGrid(value, grid, origin)`
- `roundToGrid(value, grid, origin)`

建议统一 `divisions = lcm(ppq, 480)` 或直接使用输入 PPQ 作为 tick 分母。为了
MusicXML 导出稳定，内部 Fraction 不必等于 MusicXML divisions；导出时再计算
MusicXML `<divisions>`。

## Import Options

MuseScore 把导入参数作为 operations。`midi-studio` 应保留同类参数，未来可以做
“MIDI 导入设置面板”。

```ts
export interface MidiImportOptions {
  shortestNote: "1/8" | "1/16" | "1/32" | "1/64";
  isHumanPerformance: boolean | "auto";
  detectPickupMeasure: boolean;
  detectTuplets: boolean;
  tuplets: {
    duplets: boolean;
    triplets: boolean;
    quadruplets: boolean;
    quintuplets: boolean;
    septuplets: boolean;
    nonuplets: boolean;
  };
  useDots: boolean;
  simplifyDurations: boolean;
  maxVoices: 1 | 2 | 3 | 4;
  splitPianoStaff: boolean | "auto";
  swing: "none" | "eighth" | "sixteenth";
  preservePedalAsNotation: boolean;
}
```

第一版默认：

```ts
const defaultMidiImportOptions: MidiImportOptions = {
  shortestNote: "1/16",
  isHumanPerformance: "auto",
  detectPickupMeasure: true,
  detectTuplets: false,
  tuplets: {
    duplets: false,
    triplets: true,
    quadruplets: false,
    quintuplets: false,
    septuplets: false,
    nonuplets: false
  },
  useDots: true,
  simplifyDurations: true,
  maxVoices: 2,
  splitPianoStaff: "auto",
  swing: "none",
  preservePedalAsNotation: false
};
```

## 算法模块

### 1. MIDI Track 预处理

目标：

- 合并 note-on/note-off，得到 note duration。
- 按 channel 拆分混合 track。
- 过滤非法 note：缺失 off、duration <= 0、极短音。
- 标记 drum track。
- 保留 tempo/time/key/meta。

当前 `@tonejs/midi` 已经能给出 notes，但仍要确认：

- 是否保留原始 ticks。
- 是否处理 note-on velocity 0 作为 note-off。
- 是否能读取 channel 和 program。
- 是否读取 time signature / key signature meta event。

落地函数：

```ts
export function normalizeMidi(raw: Midi): NormalizedMidiSong
```

验收：

- 同一个 MIDI 文件导入后，所有 note 都满足 `endTicks > startTicks`。
- Track/channel/program 信息在 diagnostics 中可检查。
- Tempo/time signature 不丢失。

### 2. Time Signature Map 与 Measure Map

MuseScore 在 `createMTrackList()` 中先建立 `sigmap`，并把错误落在小节中间的
time signature 吸附到小节起点。

`midi-studio` 建议实现：

```ts
export interface MeasureMapEntry {
  index: number;
  start: Fraction;
  end: Fraction;
  actualDuration: Fraction;
  nominalTimeSignature: TimeSignature;
  isPickup: boolean;
}
```

流程：

1. 没有拍号时默认 4/4。
2. 将拍号变更 tick 对齐到最近的小节起点。
3. 根据最后一个 note off 生成 measures。
4. 如果启用弱起检测，检查首个 note 前是否留有非整小节偏移。

第一版弱起策略：

- 如果第一音不在 0，且第一音到第一个完整小节的距离小于一小节，则创建 pickup。
- 如果 MIDI 已经从 tick 0 开始但第一小节实际拍号短于第二小节，可按 meta event 保留。

MuseScore 更复杂，会检查后续多个小节拍号是否相同。第一版可以更保守：只在用户开启
并且证据明确时创建 pickup。

### 3. Human Performance 检测

MuseScore 的思路是统计 beat-level onset 与 1/16 网格的匹配比例。匹配差则认为是
真人演奏，并放宽默认量化。

`midi-studio` 可实现轻量版本：

```ts
export function detectHumanPerformance(
  chords: ImportChordEvent[],
  measureMap: MeasureMapEntry[],
  grid: Fraction
): boolean
```

评分：

- 对每个唯一 onset，吸附到 1/16 或用户 shortest grid。
- 如果落在 beat 边界附近，统计偏差。
- `matchedBeatOnsets / beatOnsets < 0.6` 则认为 human。

自动调整：

- human: `shortestNote = 1/8`, `maxVoices = 2`
- clean MIDI: 保持用户默认

不要自动修改用户显式选择。只有 `isHumanPerformance: "auto"` 时启用。

### 4. 和弦聚合

MIDI 和弦的 note-on 不一定同 tick。MuseScore 用 quickthresh 思想，把近距离 note-on
合并成 chord。

第一版实现：

```ts
export function collectChords(
  events: ImportChordEvent[],
  options: MidiImportOptions
): ImportChordEvent[]
```

策略：

- clean MIDI 容差：`shortestNote / 2`
- human MIDI 容差：`shortestNote * 2`
- 只有同 voice、无同 pitch 冲突、且新 note on 早于前一 chord 最大 offTime 时合并。
- 如果 note-on 已经明显晚于前一 chord offTime，保留为琶音/后续音。

伪代码：

```text
currentChordStart = invalid
threshold = human ? minDuration * 2 : minDuration / 2
fudge = threshold / 4
extension = threshold / 2

for event in sortedEvents:
  if event.onTime < currentChordStart + threshold:
    if event.onTime <= currentChordMaxOff - minDuration:
      merge notes into previous chord
      if event starts in fudge zone:
        threshold += extension
      continue

  start new chord group
```

### 5. Tuplet 检测

MuseScore 支持 2、3、4、5、7、9 连音，候选检测在小节内按 metrical divisions 枚举。

建议第一版只做 triplet：

- 支持 3:2 八分三连音和四分三连音。
- 默认可关闭，避免误判。
- 只在 clean MIDI 上自动识别；human MIDI 需要用户开启。

候选区间：

- 简单拍号：每拍、半小节、小节。
- 复合拍号：优先每个 beat。

候选评分：

```text
regularError = sum distance(chord.onTime, regularGrid)
tupletError = sum distance(chord.onTime, tupletGrid)

accept if:
  tupletError + penalty < regularError
  chord count >= 2
  notes are mostly inside candidate range
  tuplet note length >= shortestNote
```

数据结构：

```ts
export interface TupletDraft {
  id: string;
  onTime: Fraction;
  duration: Fraction;
  actualNotes: number;
  normalNotes: number;
  voice: number;
  staff: number;
}
```

后续量化中，tuplet 内 chord 使用 `duration / actualNotes` 作为局部网格。

### 6. 量化

这是整个系统的质量核心。MuseScore 的 `quantizeChords()` 用动态规划选择每个 chord
的最佳 onset，而不是逐个独立 round。

第一版可以分两层：

#### Phase 1: nearest-grid quantization

适合先打通 MusicXML：

```ts
quantizedOn = roundToGrid(onTime, quantForNoteLength(noteLength, shortestNote), barStart)
quantizedOff = roundToGrid(offTime, quantForNoteLength(noteLength, shortestNote), barStart)
```

约束：

- `quantizedOff > quantizedOn`
- 不跨过 tuplet 边界。
- 如果 off <= on，降低网格一级，直到最小 1/128。

#### Phase 2: dynamic programming quantization

复刻 MuseScore 思路。

对每个 voice、每个小节或 tuplet range：

1. 为每个 chord 生成候选位置。
2. 每个位置有 metrical level。
3. 计算局部 penalty。
4. 用 DP 选择单调不倒退的最优路径。

候选位置：

```ts
interface QuantCandidate {
  time: Fraction;
  metricalLevel: number;
}
```

评分：

```text
timePenalty = abs(originalOnTime - candidateTime)
levelDiff = abs(durationMetricalLevel - candidateMetricalLevel)

clean MIDI:
  if candidate is stronger than expected:
    penalty = timePenalty * (1 + levelDiff)
  else:
    penalty = timePenalty

human MIDI:
  if candidate is stronger than expected:
    penalty = timePenalty + levelDiff * noteLength
  else:
    penalty = timePenalty / (1 + levelDiff)
```

转移约束：

- 当前候选不能早于前一个候选。
- 相同 onset 仅在两 chord 可合并时允许，并加 merge penalty。

伪代码：

```text
for chordIndex in chords:
  for candidate in candidates[chordIndex]:
    local = scoreLocal(chord, candidate)
    if chordIndex == 0:
      dp[chordIndex][candidate] = local
    else:
      dp = local + min(prevDp where prev.time <= candidate.time)

backtrack from minimum candidate of last chord
```

### 7. Metrical Structure 与 Duration Spelling

MuseScore 的 `Meter::toDurationList()` 会根据小节结构，把一个持续时间拆成更可读的
记谱片段。它不是简单地把 `3/8` 写成一个附点四分，而是结合拍号、强弱拍、休止规则、
tuplet 边界决定是否拆分。

`midi-studio` 建议实现：

```ts
export interface NotationDurationSegment {
  duration: Fraction;
  type: "whole" | "half" | "quarter" | "eighth" | "16th" | "32nd" | "64th";
  dots: 0 | 1 | 2;
  tupletId?: string;
  tieToNext?: boolean;
}
```

第一版规则：

- 不能跨小节：跨小节必须拆分并加 tie。
- 尽量不跨强拍：例如 4/4 中 `1/8 + 1/2 + 1/8` 要拆出中间拍界。
- 如果 `useDots`，允许附点二分、附点四分、附点八分。
- rest 比 note 更保守拆分，避免休止跨强拍。
- tuplet 内按 tuplet ratio 转换 duration。

后续增强：

- 复合拍号中，休止不要跨越 6/8 的 3+3 beat 结构。
- 3/4 中两拍休止要按上下文拆分。
- 对切分音保留 tie，而不是强行长音符。

### 8. 休止与连音线

MuseScore 在 `processPendingNotes()` 中创建 chord 后，剩余 gap 用 rest 填充；长音跨越
多个 notation duration 时创建 tie。

`midi-studio` 也应让每个 voice 独立生成完整时间线：

```text
voice cursor = measure start
for chord in voice:
  if chord.onTime > cursor:
    emit rests from cursor to chord.onTime
  emit chord segments from chord.onTime to chord.offTime
  cursor = chord.offTime or next split point
fill remaining measure with rests
```

注意：

- 不同 voice 的 rest 可以在渲染层隐藏，但 MusicXML 需要完整 voice 时值。
- 如果 chord duration 被拆成多个 segments，后续 segment 是 tie continuation。
- 同一个 chord 中不同 note duration 不一致时，应拆成多个 chord layer 或 voice。

### 9. 声部分离

MuseScore 的声部分离目标是让同一 staff 中重叠的音合法显示，并减少复杂 duration。

第一版策略：

- 默认每个 track 一个 voice。
- 如果某 note 与同 voice 后续 chord 重叠，则尝试移到空闲 voice。
- 最多 `maxVoices`。
- 优先保持同 pitch/同旋律线在同 voice。

增强版可以借鉴 MuseScore：

- 对同 onset、不同 offTime 的 chord，按 offTime 排序。
- 枚举 split point，把低音组或高音组移到其他 voice。
- 评分目标：拆分后 notation duration 数量最少，且不与目标 voice 已有 chord 重叠。

验收：

- 同一 staff、同一 voice 中，任意两个 chord 不应有非法重叠。
- 相同 pitch 在同 voice 中不应重叠。
- 超出 voice 上限时记录 diagnostic，并退化为切短或合并。

### 10. 钢琴左右手拆分

MuseScore 不用固定 middle C，而用动态规划选择每个 chord 的 split point。第一版可以先
做保守策略，再升级 DP。

#### Phase 1: pitch threshold

- 仅对 piano / grand staff program 自动启用。
- 默认 split pitch: MIDI 60。
- 如果 chord 横跨 split pitch，则按音高分组。
- 如果一组为空，整个 chord 放到更接近平均音高的一侧。

#### Phase 2: dynamic programming

每个 chord 的候选 split point 是 `0..notes.length`：

- `0`: 全部右手。
- `notes.length`: 全部左手。
- 中间值：低音左手，高音右手。

评分：

- 单手音域超过八度惩罚。
- 相邻 chord split point 变化过大惩罚。
- 八度、伴奏型、单音旋律延续奖励。
- 左右手与前序 chord 重叠惩罚。
- 右手 note count 明显少于左手时轻微惩罚。

输出：

- 一个 part，两条 staff。
- 左手 staff 默认 bass clef。
- 右手 staff 默认 treble clef。
- 后续 clef detection 可按音域动态调整。

### 11. 调号与音高拼写

MuseScore MIDI 缺失 key 时使用一个简单统计法：统计相邻 chord 间半音移动的位置，
按不同调号候选排序，优先 transition count 高且 accidental 少的 key。

`midi-studio` 第一版：

- 如果 MIDI 有 key signature，直接使用。
- 如果没有，默认 C major / A minor，并记录 diagnostic。
- 可选实现 key detection，用 pitch class histogram + accidentals cost。

音高拼写：

```ts
export function spellPitch(
  midiPitch: number,
  key: KeySignature,
  context: PitchSpellingContext
): SpelledPitch
```

第一版：

- 按调号默认拼写。
- C major 中默认使用 sharps 或按五度圈偏好。
- 同一小节内尽量避免同 pitch class 反复变 enharmonic。

后续：

- 根据旋律方向选择 leading tone。
- 根据和弦识别选择 chord tone spelling。

### 12. 谱号识别

第一版规则：

- Drum: percussion clef。
- Piano split: 右手 treble，左手 bass。
- 普通 track:
  - 平均 pitch >= 60: treble
  - 平均 pitch < 60: bass
  - 中提琴/大提琴等后续按 instrument template 扩展。

增强：

- 按 measure 音域动态插入 clef change。
- 避免频繁切换，至少间隔若干小节。

### 13. Drum Track

MuseScore 对 drum 有专门处理：drum voice、stem direction、rests 简化、drumset 映射。

`midi-studio` 第一阶段可以：

- 标记 drum track，但不导出标准鼓谱。
- MusicXML 中用 unpitched 或暂时用 percussion pitch 映射。
- 五线谱 UI 可先提示 drum notation limited。

鼓谱完整支持应单独规划，不要阻塞普通 MIDI 五线谱。

### 14. Pedal 与 Controller

钢琴 MIDI 常有 sustain pedal。MuseScore 当前 MIDI import 核心更关注 note event，
而 pedal 对“实际发声”与“乐谱时值”有不同含义。

建议：

- 乐谱转换默认使用 note-off，不用 pedal 延长 notation duration。
- 如果导出 playback MusicXML，可额外输出 pedal direction。
- 后续支持 `preservePedalAsNotation` 时，将 CC64 生成 pedal marks，而不是改长音符。

## MusicXML 导出设计

MusicXML exporter 应从 `ScoreDraft` 输出 `score-partwise`。

### 导出结构

```xml
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1">
      <part-name>Piano</part-name>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      ...
    </measure>
  </part>
</score-partwise>
```

### divisions

MusicXML `<duration>` 使用 divisions。建议导出前计算全曲最小公倍数：

```text
divisions = lcm(denominators of all note/rest duration fractions relative to quarter)
```

保守默认可用：

```text
divisions = 960
```

这样能表达 1/16、1/32、三连音等常见时值。后续再优化为按实际内容计算。

### note/rest 输出

Chord：

```xml
<note>
  <pitch>
    <step>C</step>
    <alter>1</alter>
    <octave>4</octave>
  </pitch>
  <duration>480</duration>
  <voice>1</voice>
  <type>eighth</type>
  <staff>1</staff>
</note>
```

同一 chord 的第二个及后续 note 添加：

```xml
<chord/>
```

Rest：

```xml
<note>
  <rest/>
  <duration>960</duration>
  <voice>1</voice>
  <type>quarter</type>
</note>
```

Tie：

```xml
<tie type="start"/>
<notations>
  <tied type="start"/>
</notations>
```

Tuplet：

```xml
<time-modification>
  <actual-notes>3</actual-notes>
  <normal-notes>2</normal-notes>
</time-modification>
<notations>
  <tuplet type="start" number="1"/>
</notations>
```

### 多声部和多谱表

- `voice` 使用 1-based 字符串或数字。
- `staff` 使用 1-based。
- 同一 measure 内每个 voice 必须 duration 总和一致。
- 需要 backup/forward 在 MusicXML 中切换 voice/staff。

第一版可采用简单策略：

```text
for each staff:
  for each voice:
    if not first voice:
      emit <backup> measureDuration </backup>
    emit voice events
```

## 渲染器选择

短期建议：

- MusicXML 导出先落文件或内存字符串。
- 五线谱预览可优先评估 OpenSheetMusicDisplay 或 alphaTab MusicXML。

考虑到项目已使用 alphaSynth，alphaTab 生态可能更贴近现有播放链路。但如果目标是
标准五线谱 MusicXML 预览，OpenSheetMusicDisplay 更直接。

本项目当前已经选择并实现了轻量自研 SVG staff renderer，以便播放高亮和位置映射可控。
后续仍可通过 MusicXML export 对接 OSMD/Verovio/MuseScore 做高质量预览或验证。

## 可落地实施阶段

### Stage 0: 基础结构

新增：

```text
src/renderer/lib/score/fraction.ts
src/renderer/lib/score/types.ts
src/renderer/lib/score/createScoreDraft.ts
src/renderer/lib/score/musicxml.ts
```

输出：

- 可以从当前 MIDI song 生成单 part、单 staff、单 voice 的 ScoreDraft。
- 可导出 MusicXML。

范围：

- 只支持 clean MIDI。
- 只支持 4/4 或 MIDI 明确拍号。
- 量化到 1/16。
- 无 tuplets。
- 无复杂 voice separation。

验收：

- 简单 C 大调旋律 MIDI 导出 MusicXML 可被 MuseScore 打开。
- 小节 duration 总和正确。
- 休止补齐正确。

### Stage 1: 可读时值与连音线

实现：

- measure map。
- duration spelling。
- 跨小节 tie。
- 附点。
- rest splitting。

验收：

- 跨小节长音导出为 tie。
- 4/4 中切分音不会生成非法 duration。
- MusicXML 通过基本 schema/打开验证。

### Stage 2: 多 track、谱号、调号、MusicXML 完整度

实现：

- track -> part。
- program/name/channel。
- time/key signatures。
- treble/bass clef。
- tempo directions。

验收：

- 多轨 MIDI 导出为多个 part。
- 有 key signature 的 MIDI 保留调号。
- MuseScore/OSMD 打开后每个 part 小节对齐。

### Stage 3: 声部分离

实现：

- 同 staff 最多 2 voice。
- 重叠 note 自动分 voice。
- 同 onset 不同时值拆分。

验收：

- 复调简单钢琴右手能生成两个 voice。
- 同一 voice 无非法重叠。
- MusicXML backup/voice 正确。

### Stage 4: 钢琴左右手拆分

实现：

- splitPianoStaff auto。
- pitch threshold baseline。
- 后续 DP 分手。

验收：

- 钢琴 MIDI 输出 grand staff。
- 左手低音谱号，右手高音谱号。
- 大跨距 chord 能合理拆到两手。

### Stage 5: Tuplet

实现：

- triplet detection。
- tuplet quantization。
- MusicXML time-modification/tuplet notation。

验收：

- 八分三连音 MIDI 导出为三连音，而不是奇怪的 1/16/1/32 组合。
- 可关闭 tuplet detection 并回退常规量化。

### Stage 6: Human Performance Import

实现：

- human detection。
- beat adjustment。
- DP quantization。
- import diagnostics UI。

验收：

- 轻微提前/拖后的真人 MIDI 能吸附到合理拍点。
- 用户能调 shortest note / human mode 后重新生成 ScoreDraft。

## Diagnostics

每次导入应产生 diagnostics，便于 UI 提示和测试：

```ts
export interface ImportDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  trackIndex?: number;
  tick?: Fraction;
}
```

建议诊断项：

- `MISSING_TIME_SIGNATURE`
- `MISSING_KEY_SIGNATURE`
- `QUANTIZATION_COLLISION`
- `VOICE_LIMIT_EXCEEDED`
- `TUPLET_AMBIGUOUS`
- `PEDAL_IGNORED_FOR_NOTATION`
- `DRUM_NOTATION_LIMITED`
- `MUSICXML_DURATION_MISMATCH`

## 测试策略

### 单元测试

核心算法必须单测：

- Fraction 运算。
- tick/fraction 转换。
- measure map。
- quantizeValue。
- duration spelling。
- rest filling。
- MusicXML duration sum。

### Golden MIDI Fixtures

新增测试素材目录：

```text
src/renderer/lib/score/__fixtures__/
```

建议 fixture：

- `scale-c-major-4-4.mid`
- `rests-and-ties.mid`
- `dotted-rhythm.mid`
- `two-voices-overlap.mid`
- `piano-grand-staff.mid`
- `triplets.mid`
- `human-slightly-off-grid.mid`

每个 fixture 保存期望的简化 JSON：

```text
expected.score-draft.json
expected.musicxml.snap.xml
```

### MusicXML 验证

第一阶段最低验证：

- XML well-formed。
- 每个 measure 每个 voice duration sum 等于 measure duration。
- MuseScore 可打开。

后续可引入 MusicXML XSD 校验，但注意 Node 16 兼容和依赖体积。

## 与现有代码集成

当前播放器应继续使用现有 MIDI song model。五线谱转换作为旁路：

```text
src/renderer/lib/midi.ts
  -> existing playback
  -> createScoreDraft()
       -> staff preview
       -> exportMusicXml()
```

不要让播放引擎依赖 ScoreDraft。这样可以避免转换失败影响播放。

UI 层建议新增状态：

```ts
type ScoreDraftState =
  | { status: "idle" }
  | { status: "building" }
  | { status: "ready"; score: ScoreDraft }
  | { status: "failed"; error: string };
```

当用户更改导入选项时重新生成 ScoreDraft，而不是重新解析 MIDI 文件。

## 风险与边界

### GPL 风险

MuseScore 是 GPL-3.0。`midi-studio` 当前是 MIT。可以学习架构、算法思想和行为，
但不能复制 MuseScore 源码实现。实现时应独立编写 TypeScript 代码，避免逐行翻译。

### 质量风险

MIDI 转谱没有唯一正确答案。质量取决于：

- MIDI 是否来自制谱软件还是真人演奏。
- 是否有拍号/调号/tempo meta。
- 是否有踏板。
- 钢琴复调复杂度。
- 用户是否愿意调整导入参数。

因此必须设计 diagnostics 和 import options，不要把转换包装成永远正确的一键功能。

### 性能风险

DP 量化、voice separation、piano split 都可能随 chord 数增长。应按 track/measure 分块，
避免整首曲子全局 DP。

推荐粒度：

- quantization: per track, per voice, per measure/range。
- voice separation: per track, per phrase or measure window。
- piano split: per track, sliding window 或整轨但只保留必要状态。

## 第一版最小可行方案

如果要尽快在 `midi-studio` 内落地，建议先做这个闭环：

```text
Normalized MIDI
-> track notes
-> collect chords
-> quantize to 1/16
-> create measures
-> fill rests
-> split at bar boundaries with ties
-> spell pitch in C major
-> export MusicXML
```

暂不做：

- tuplets
- human performance beat detection
- DP quantization
- advanced voice separation
- piano DP split
- drum notation

这个闭环已经能验证架构是否正确，并能让 MusicXML 被 MuseScore/OSMD 打开。随后再按
Stage 1-6 提升质量。

## 推荐文件清单

第一批实现文件：

```text
src/renderer/lib/score/types.ts
src/renderer/lib/score/measureMap.ts
src/renderer/lib/score/meterStructure.ts
src/renderer/lib/score/quantization.ts
src/renderer/lib/score/durations.ts
src/renderer/lib/score/rhythmSpelling.ts
src/renderer/lib/score/createScoreDraft.ts
src/renderer/lib/score/index.ts
```

后续增强文件：

```text
src/renderer/lib/score/musicxml.ts
src/renderer/lib/score/tuplets.ts
src/renderer/lib/score/keyDetection.ts
src/renderer/lib/score/diagnostics.ts
```

## Definition of Done

MIDI 转五线谱/MusicXML 第一阶段完成的标准：

- 不破坏现有 MIDI 播放、五线谱渲染和 alphaSynth 播放。
- 一个 clean 4/4 单轨 MIDI 可以生成 ScoreDraft。
- ScoreDraft 可以导出 well-formed MusicXML。
- MusicXML 在 MuseScore 中可打开。
- 每小节每声部 duration 总和正确。
- 跨小节 note 使用 tie。
- 缺失拍号/调号时有 diagnostics。
- 核心 Fraction、measure、duration、MusicXML duration sum 有单元测试。

## 参考实现要点摘要

MuseScore 最值得借鉴的不是某个单独函数，而是这些工程原则：

- 先建中间模型，再创建乐谱 DOM 或 MusicXML。
- 量化需要结合节拍层级和全局单调约束。
- tuplets 必须在常规量化前识别。
- 左右手分离和量化都适合用动态规划。
- 声部分离的目标是减少记谱复杂度，而不只是按音高分组。
- 用户可调导入参数是必要功能，不是附加功能。
- MusicXML 导出应从乐谱模型生成，而不是从 MIDI event 直接生成。
