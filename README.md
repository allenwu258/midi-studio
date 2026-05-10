# midi-studio

midi-studio 是一个本地优先的开源 MIDI 练习桌面应用，基于 React、Electron、
Vite 和 TypeScript 构建。

当前版本已经从早期简谱原型演进为五线谱主链路：可以打开本地 MIDI，在 Worker
中解析和生成结构化乐谱，通过 alphaSynth + SF2 或 Web Audio fallback 播放，并在
五线谱上同步高亮播放位置。

English README: [README.en.md](README.en.md)

## 当前状态

- 支持本地 `.mid` / `.midi` 文件导入。
- 支持本地 `.xml` / `.musicxml` / `.mxl` 文件导入，MusicXML 解析与谱面生成已拆到
  独立 Worker。
- 使用 `@tonejs/midi` 解析 MIDI，解析过程已搬到 Worker。
- 支持 alphaSynth + SF2 SoundFont 播放，优先 AudioWorklet，失败后自动降级到
  ScriptProcessor 并记录诊断。
- 保留纯 Web Audio 合成器作为备用播放模式。
- 支持播放、暂停、停止、seek、调速和主音量。
- 底部播放栏默认锁定在窗口底部，也可取消锁定后随页面滚动到末尾；播放跟随按钮也
  位于播放栏内，默认开启且不写入 SQLite。
- 设置通过 SQLite 持久化。
  - 播放模式可在 `SF2 合成` / `纯 MIDI` 间切换；
  - 谱面渲染模式可在 `Engraved SVG` / `Classic JSX` 间切换。
- MIDI 转五线谱管线：
  - 小节图和拍号边界对齐；
  - 带调号意识的音高拼写；
  - 钢琴双谱表拆分；
  - 小节级 quantization beam search；
  - duration spelling、休止、tie 和基础 tuplet；
  - voice split window search；
  - 播放时间到乐谱元素的双向映射。
- MusicXML 导入管线：
  - 直接保留原始 voice/staff、note type/dots、tuplet/time-modification、tie 语义和
    measure attributes；
  - 谱面直建 `ScoreDraft`，播放仍继续输出 MIDI bytes 给 alphaSynth；
  - `.mxl` 支持通过容器解包导入；
  - `npm run validate:musicxml-fixtures` 覆盖单声部、和弦、rest、backup/forward、多
    voice、双谱表、tie、tempo、key/time change 和 `.mxl`。
- 五线谱渲染：
  - 可切换 `Engraved SVG` 和 `Classic JSX` 两条渲染路径，默认使用
    `Engraved SVG`，旧 JSX 引擎仍保留为回退/对照；
  - `Engraved SVG` 使用统一 SVG 字符串渲染源，屏幕显示和 SVG 导出共享同一
    markup/style helper；
  - SVG staff system、谱号、小节、音符、休止符、tie、beam、tuplet；
  - time-slice spacing、glyph boxes 和基础 collision avoidance；
  - 播放高亮 overlay 与 React 状态解耦；
  - 跟随播放滚动以当前 active score event 的 tick 位置定位，横向和纵向分别命中实际
    可滚动容器，减少多声部/双谱表场景下的跳动。
- 播放可靠性诊断：
  - 实际输出模式和 fallback reason；
  - alphaSynth 脚本、SF2、MIDI 加载耗时；
  - parse/render worker 耗时；
  - 播放期间 long task 观察；
  - overlay 更新指标。

## 环境要求

- Node.js 16.19 或更新版本。
- npm 8 或更新版本。

项目仍以 Node 16 为目标，因此依赖版本保持相对保守。

## 快速开始

安装依赖：

```bash
npm install
```

启动开发模式：

```bash
npm run dev
```

Renderer 开发服务器地址：

```text
http://127.0.0.1:5173
```

构建应用：

```bash
npm run build
```

构建 Windows portable 可执行文件：

```bash
npm run dist:portable
```

portable 构建产物写入 `release/`，该目录已被 git 忽略。

## 脚本

| 脚本 | 说明 |
| --- | --- |
| `npm run dev` | 同时启动 Vite 和 Electron。 |
| `npm run dev:renderer` | 只启动 Vite renderer server。 |
| `npm run dev:electron` | 等待 Vite、编译 Electron 代码并启动 Electron。 |
| `npm run build` | 构建 Electron main/preload 和 renderer bundle。 |
| `npm run dist:dir` | 构建未打包的 Windows app 目录，用于调试 packaging 输出。 |
| `npm run dist:portable` | 构建未签名的 Windows portable 可执行文件。 |
| `npm run preview` | 本地预览构建后的 renderer bundle。 |
| `npm run typecheck` | 检查 renderer 和 Electron TypeScript。 |
| `npm run validate:score-fixtures` | 校验仓库内的乐谱 JSON fixture。 |
| `npm run validate:musicxml-fixtures` | 校验仓库内的 MusicXML 导入 fixture。 |

## 项目结构

```text
midi-studio/
  src/
    main/          Electron 主进程、资源协议、设置 IPC
    preload/       暴露给 renderer 的隔离桥
    renderer/
      features/    React 功能界面和五线谱 UI
      lib/
        midi.ts    MIDI 解析和标准化曲目模型
        player/    alphaSynth / WebAudio 播放引擎
        score/     MIDI 到 ScoreDraft 的算法管线
        staff/     RenderScore 布局、Engraved/Classic SVG 渲染和导出辅助
        playbackMap/
        time.ts
      workers/     MIDI parse worker 和 score render worker
  public/
    soundfonts/    内置 SF2 SoundFont
    vendor/        内置 alphaSynth browser script
```

## 架构说明

- Renderer 是普通 React 应用。
- Electron main process 负责窗口生命周期、资源协议和设置存储。
- Preload 是 renderer 与 Electron 权限能力之间的唯一桥。
- `contextIsolation` 保持开启，`nodeIntegration` 保持关闭。
- alphaSynth 和 SF2 资源通过 `midi-studio-resource://assets/...` 加载，避免从
  renderer source 直接 import `public/` 资源。
- MIDI 解析和五线谱生成运行在 Worker 中，避免阻塞播放关键路径。
- Score render worker 会接收当前谱面渲染模式，并按 `Engraved SVG` /
  `Classic JSX` 选择对应 layout options。
- 播放 clock 不驱动 React 高频 rerender；五线谱高亮使用 imperative overlay 和
  聚合诊断。
- 底部 transport 可锁定为固定工具栏；固定时根据真实 toolbar 高度动态预留底部空间，
  避免遮挡谱面内容。
- 跟随播放是 transport 上的会话级控制，默认开启，不属于 SQLite 设置；关闭后停止自动
  滚动但保持当前音符高亮。

完整系统架构与技术实现见：

```text
docs/system-architecture-and-technical-implementation.md
```

## 验证

提交前至少运行：

```bash
npm run typecheck
npm run validate:score-fixtures
npm run build
```

UI 改动还应运行：

```bash
npm run dev
```

并检查：

```text
http://127.0.0.1:5173
```

## 内置音频资源

SF2 播放链路使用这些本地资源：

```text
public/vendor/alphasynth/alphaSynth.min.js
public/soundfonts/midiSound-2025-1-14.sf2
```

用户已确认 alphaSynth 为开源资源，当前 SF2 文件允许用于本项目。后续不要在未确认
再分发权利的情况下替换 SoundFont；替换时也需要同步更新文档。

## 路线图

- 继续改进 quantization：扩展 tuplet 候选，并用 fixture 对 penalty 做校准。
- 改进 engraving geometry：更强的 spacing、collision solving、真实 SMuFL 字体和
  glyph metric。
- 继续补 MusicXML 导入覆盖和谱面保真，再推进 MusicXML 导出。
- 从 `ScoreDraft` 导出 MusicXML。
- 增加钢琴键盘可视化。
- 增加谱面图片/PDF 和离线音频导出。
- 继续扩展播放和渲染可靠性诊断。

## 许可证

MIT
