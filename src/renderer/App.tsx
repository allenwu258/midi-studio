import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type SettingsStorageInfo, type UserSettings } from "../shared/settings";
import { StaffNotationPanel } from "./features/notation/StaffNotationPanel";
import { SettingsPage } from "./features/settings/SettingsPage";
import type { ParsedSong } from "./lib/midi";
import { createPlayer } from "./lib/player/createPlayer";
import type {
  MidiPlaybackEngine,
  PlayerDiagnostics,
  PlayerLoadInput,
  PlayerSnapshot
} from "./lib/player/types";
import type { PlaybackMapEntry } from "./lib/playbackMap";
import type { ScoreDraft } from "./lib/score";
import type { RenderScore } from "./lib/staff";
import { formatTime } from "./lib/time";
import type { MidiParseRequest, MidiParseResponse } from "./workers/midiParseMessages";
import type { ScoreRenderRequest, ScoreRenderResponse } from "./workers/scoreRenderMessages";

type AppView = "player" | "settings";
type PlaybackRuntimeDiagnostics = {
  longTaskCount: number;
  longestLongTaskMs: number;
  midiParseWorkerMs?: number;
  midiParseError?: string;
  scoreRenderWorkerMs?: number;
  scoreRenderError?: string;
  snapshotCommitCount: number;
  overlayUpdateCount: number;
  overlayLookupMs?: number;
  overlayEventCount: number;
};
type OverlayMetricsAccumulator = {
  pendingUpdateCount: number;
  lookupMs?: number;
  activeEventCount: number;
  dirty: boolean;
};
type MidiParseResult = {
  song: ParsedSong;
  durationMs: number;
};
type ScoreRenderState =
  | {
      status: "idle" | "rendering";
      score: null;
      renderScore: null;
      playbackMap: PlaybackMapEntry[];
      error: "";
    }
  | {
      status: "ready";
      score: ScoreDraft;
      renderScore: RenderScore;
      playbackMap: PlaybackMapEntry[];
      error: "";
    }
  | {
      status: "error";
      score: null;
      renderScore: null;
      playbackMap: PlaybackMapEntry[];
      error: string;
    };

const PLAYBACK_SNAPSHOT_INTERVAL_MS = 125;
const PLAYBACK_DIAGNOSTICS_FLUSH_MS = 1000;
const EMPTY_PLAYBACK_MAP: PlaybackMapEntry[] = [];
const DEFAULT_RUNTIME_DIAGNOSTICS: PlaybackRuntimeDiagnostics = {
  longTaskCount: 0,
  longestLongTaskMs: 0,
  snapshotCommitCount: 0,
  overlayUpdateCount: 0,
  overlayEventCount: 0
};
const DEFAULT_OVERLAY_METRICS: OverlayMetricsAccumulator = {
  pendingUpdateCount: 0,
  activeEventCount: 0,
  dirty: false
};

export function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const playerRef = useRef<MidiPlaybackEngine>(
    createPlayer({
      mode: DEFAULT_SETTINGS.playbackEngineMode,
      masterVolumePercent: DEFAULT_SETTINGS.masterVolumePercent
    })
  );
  const playerModeRef = useRef(DEFAULT_SETTINGS.playbackEngineMode);
  const playerUnsubscribeRef = useRef<(() => void) | null>(null);
  const playerDiagnosticsUnsubscribeRef = useRef<(() => void) | null>(null);
  const playerDisposeTimeoutRef = useRef<number | null>(null);
  const scoreRenderWorkerRef = useRef<Worker | null>(null);
  const scoreRenderRequestIdRef = useRef(0);
  const currentLoadInputRef = useRef<PlayerLoadInput | null>(null);
  const loadGenerationRef = useRef(0);
  const settingsRef = useRef<UserSettings>(DEFAULT_SETTINGS);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSettingsSaveCountRef = useRef(0);
  const snapshotStatusRef = useRef<PlayerSnapshot["status"]>(playerRef.current.getSnapshot().status);
  const overlayMetricsRef = useRef<OverlayMetricsAccumulator>({ ...DEFAULT_OVERLAY_METRICS });
  const [song, setSong] = useState<ParsedSong | null>(null);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(() => playerRef.current.getSnapshot());
  const [playerDiagnostics, setPlayerDiagnostics] = useState<PlayerDiagnostics>(() =>
    playerRef.current.getDiagnostics()
  );
  const [runtimeDiagnostics, setRuntimeDiagnostics] = useState<PlaybackRuntimeDiagnostics>(
    DEFAULT_RUNTIME_DIAGNOSTICS
  );
  const [speed, setSpeed] = useState(100);
  const [error, setError] = useState("");
  const [view, setView] = useState<AppView>("player");
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [storageInfo, setStorageInfo] = useState<SettingsStorageInfo | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [scoreRenderState, setScoreRenderState] = useState<ScoreRenderState>({
    status: "idle",
    score: null,
    renderScore: null,
    playbackMap: EMPTY_PLAYBACK_MAP,
    error: ""
  });

  useEffect(() => {
    cancelPendingPlayerDispose();
    playerUnsubscribeRef.current = playerRef.current.subscribe(commitPlayerSnapshot);
    playerDiagnosticsUnsubscribeRef.current = playerRef.current.subscribeDiagnostics(setPlayerDiagnostics);
    const intervalId = window.setInterval(() => {
      const nextSnapshot = playerRef.current.getSnapshot();

      commitPlayerSnapshot(nextSnapshot);
    }, PLAYBACK_SNAPSHOT_INTERVAL_MS);

    return () => {
      playerUnsubscribeRef.current?.();
      playerUnsubscribeRef.current = null;
      playerDiagnosticsUnsubscribeRef.current?.();
      playerDiagnosticsUnsubscribeRef.current = null;
      window.clearInterval(intervalId);
      schedulePlayerDispose();
    };
  }, []);

  useEffect(() => {
    const observerConstructor = window.PerformanceObserver;
    const supportedEntryTypes = observerConstructor?.supportedEntryTypes ?? [];

    if (!observerConstructor || !supportedEntryTypes.includes("longtask")) {
      return undefined;
    }

    const observer = new observerConstructor((list) => {
      const entries = list.getEntries();

      if (snapshotStatusRef.current !== "playing" || entries.length === 0) {
        return;
      }

      setRuntimeDiagnostics((previousDiagnostics) => {
        const longestLongTaskMs = entries.reduce(
          (maxDuration, entry) => Math.max(maxDuration, entry.duration),
          previousDiagnostics.longestLongTaskMs
        );

        return {
          ...previousDiagnostics,
          longTaskCount: previousDiagnostics.longTaskCount + entries.length,
          longestLongTaskMs
        };
      });
    });

    observer.observe({ entryTypes: ["longtask"] });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const overlayMetrics = overlayMetricsRef.current;

      if (!overlayMetrics.dirty) {
        return;
      }

      overlayMetricsRef.current = { ...DEFAULT_OVERLAY_METRICS };
      setRuntimeDiagnostics((previousDiagnostics) => ({
        ...previousDiagnostics,
        overlayUpdateCount:
          previousDiagnostics.overlayUpdateCount + overlayMetrics.pendingUpdateCount,
        overlayLookupMs: overlayMetrics.lookupMs,
        overlayEventCount: overlayMetrics.activeEventCount
      }));
    }, PLAYBACK_DIAGNOSTICS_FLUSH_MS);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    let isMounted = true;

    async function loadSettings() {
      try {
        const [nextSettings, nextStorageInfo] = await Promise.all([
          window.midiStudio.settings.get(),
          window.midiStudio.settings.getStorageInfo()
        ]);

        if (!isMounted) {
          return;
        }

        commitSettings(nextSettings);
        setStorageInfo(nextStorageInfo);
        setSpeed(nextSettings.defaultSpeedPercent);
        playerRef.current.setSpeed(nextSettings.defaultSpeedPercent);
        playerRef.current.setMasterVolume(nextSettings.masterVolumePercent);
        await switchPlayer(nextSettings.playbackEngineMode, {
          reloadCurrentSong: Boolean(currentLoadInputRef.current),
          speedPercent: nextSettings.defaultSpeedPercent,
          settings: nextSettings
        });
      } catch (err) {
        if (!isMounted) {
          return;
        }

        setSettingsError(err instanceof Error ? err.message : "设置读取失败。");
      }
    }

    void loadSettings();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    scoreRenderRequestIdRef.current += 1;
    const requestId = scoreRenderRequestIdRef.current;

    scoreRenderWorkerRef.current?.terminate();
    scoreRenderWorkerRef.current = null;

    if (!song) {
      setScoreRenderState({
        status: "idle",
        score: null,
        renderScore: null,
        playbackMap: EMPTY_PLAYBACK_MAP,
        error: ""
      });
      return;
    }

    const worker = new Worker(new URL("./workers/scoreRenderWorker.ts", import.meta.url), {
      type: "module"
    });

    scoreRenderWorkerRef.current = worker;
    setScoreRenderState({
      status: "rendering",
      score: null,
      renderScore: null,
      playbackMap: EMPTY_PLAYBACK_MAP,
      error: ""
    });

    worker.onmessage = (event: MessageEvent<ScoreRenderResponse>) => {
      const response = event.data;

      if (scoreRenderRequestIdRef.current !== response.requestId) {
        return;
      }

      if (response.status === "success") {
        setRuntimeDiagnostics((previousDiagnostics) => ({
          ...previousDiagnostics,
          scoreRenderWorkerMs: response.durationMs,
          scoreRenderError: undefined
        }));
        setScoreRenderState({
          status: "ready",
          score: response.score,
          renderScore: response.renderScore,
          playbackMap: response.playbackMap,
          error: ""
        });
      } else {
        setRuntimeDiagnostics((previousDiagnostics) => ({
          ...previousDiagnostics,
          scoreRenderWorkerMs: response.durationMs,
          scoreRenderError: response.message
        }));
        setScoreRenderState({
          status: "error",
          score: null,
          renderScore: null,
          playbackMap: EMPTY_PLAYBACK_MAP,
          error: response.message
        });
      }
    };

    worker.onerror = (event) => {
      if (scoreRenderRequestIdRef.current !== requestId) {
        return;
      }

      setScoreRenderState({
        status: "error",
        score: null,
        renderScore: null,
        playbackMap: EMPTY_PLAYBACK_MAP,
        error: event.message || "乐谱生成线程失败。"
      });
    };

    const request: ScoreRenderRequest = { requestId, song };
    worker.postMessage(request);

    return () => {
      worker.terminate();
      if (scoreRenderWorkerRef.current === worker) {
        scoreRenderWorkerRef.current = null;
      }
    };
  }, [song]);

  const getPlaybackPosition = useCallback(() => playerRef.current.getSnapshot().positionMs, []);

  const recordOverlayMetrics = useCallback((metrics: { lookupMs: number; activeEventCount: number }) => {
    overlayMetricsRef.current = {
      pendingUpdateCount: overlayMetricsRef.current.pendingUpdateCount + 1,
      lookupMs: metrics.lookupMs,
      activeEventCount: metrics.activeEventCount,
      dirty: true
    };
  }, []);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    const loadGeneration = loadGenerationRef.current + 1;
    let loadingPlayer = playerRef.current;

    try {
      setError("");
      loadGenerationRef.current = loadGeneration;
      const buffer = await file.arrayBuffer();
      const midiBytes = buffer.slice(0);
      overlayMetricsRef.current = { ...DEFAULT_OVERLAY_METRICS };
      setRuntimeDiagnostics(DEFAULT_RUNTIME_DIAGNOSTICS);
      const parseResult = await parseMidiInWorker(buffer, file.name, loadGeneration);
      const parsedSong = parseResult.song;

      if (loadGenerationRef.current !== loadGeneration) {
        return;
      }

      setRuntimeDiagnostics((previousDiagnostics) => ({
        ...previousDiagnostics,
        midiParseWorkerMs: parseResult.durationMs,
        midiParseError: undefined
      }));

      const loadInput = {
        midiBytes,
        notes: parsedSong.notes,
        durationMs: parsedSong.durationMs
      };

      loadingPlayer = playerRef.current;
      currentLoadInputRef.current = loadInput;
      setSong(parsedSong);
      loadingPlayer.setMasterVolume(settings.masterVolumePercent);
      setSpeed(settings.defaultSpeedPercent);
      await loadingPlayer.load(loadInput);
      loadingPlayer.setSpeed(settings.defaultSpeedPercent);
    } catch (err) {
      if (loadGenerationRef.current !== loadGeneration || playerRef.current !== loadingPlayer) {
        return;
      }

      setRuntimeDiagnostics((previousDiagnostics) => ({
        ...previousDiagnostics,
        midiParseWorkerMs: getTimedWorkerErrorDuration(err) ?? previousDiagnostics.midiParseWorkerMs,
        midiParseError: err instanceof Error ? err.message : "MIDI 解析失败。"
      }));
      setSong(null);
      currentLoadInputRef.current = null;
      loadingPlayer.stop();
      setError(err instanceof Error ? err.message : "MIDI 或音频加载失败。");
    } finally {
      event.currentTarget.value = "";
    }
  }

  async function togglePlay() {
    if (!song) {
      fileInputRef.current?.click();
      return;
    }

    if (snapshot.status === "playing") {
      playerRef.current.pause();
      return;
    }

    await playerRef.current.play();
  }

  function stopPlayback() {
    playerRef.current.stop();
  }

  function seekTo(value: number) {
    playerRef.current.seek(value);
  }

  function changeSpeed(value: number) {
    setSpeed(value);
    playerRef.current.setSpeed(value);
  }

  async function updateSettings(patch: Partial<UserSettings>) {
    pendingSettingsSaveCountRef.current += 1;
    setIsSavingSettings(true);

    const queuedUpdate = settingsSaveQueueRef.current
      .catch(() => undefined)
      .then(() => applySettingsUpdate(patch))
      .finally(() => {
        pendingSettingsSaveCountRef.current -= 1;
        if (pendingSettingsSaveCountRef.current === 0) {
          setIsSavingSettings(false);
        }
      });

    settingsSaveQueueRef.current = queuedUpdate.catch(() => undefined);
    return queuedUpdate;
  }

  async function applySettingsUpdate(patch: Partial<UserSettings>) {
    const previousSettings = settingsRef.current;

    try {
      setSettingsError("");
      const nextSettings = await window.midiStudio.settings.update(patch);
      playerRef.current.setMasterVolume(nextSettings.masterVolumePercent);

      if (nextSettings.playbackEngineMode !== previousSettings.playbackEngineMode) {
        try {
          await switchPlayer(nextSettings.playbackEngineMode, {
            reloadCurrentSong: true,
            settings: nextSettings
          });
        } catch (switchError) {
          const revertedSettings = await window.midiStudio.settings.update({
            playbackEngineMode: previousSettings.playbackEngineMode
          });
          commitSettings(revertedSettings);
          playerRef.current.setMasterVolume(revertedSettings.masterVolumePercent);
          throw new Error(
            `播放模式切换失败：${
              switchError instanceof Error ? switchError.message : "播放器加载失败。"
            }`
          );
        }
      }

      commitSettings(nextSettings);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "设置保存失败。");
    }
  }

  async function switchPlayer(
    mode: UserSettings["playbackEngineMode"],
    options: { reloadCurrentSong: boolean; settings: UserSettings; speedPercent?: number }
  ) {
    if (playerModeRef.current === mode) {
      return;
    }

    const previousPlayer = playerRef.current;
    const loadInput = currentLoadInputRef.current;
    const expectedLoadInput = loadInput;
    const targetSpeed = options.speedPercent ?? speed;
    const nextPlayer = createPlayer({
      mode,
      masterVolumePercent: options.settings.masterVolumePercent
    });

    try {
      if (options.reloadCurrentSong && loadInput) {
        const switchLoadGeneration = loadGenerationRef.current + 1;

        loadGenerationRef.current = switchLoadGeneration;
        await nextPlayer.load(loadInput);
        if (
          loadGenerationRef.current !== switchLoadGeneration ||
          currentLoadInputRef.current !== expectedLoadInput ||
          playerRef.current !== previousPlayer
        ) {
          throw new Error("播放模式切换已被新的 MIDI 加载取消。");
        }
      }
      nextPlayer.setSpeed(targetSpeed);
    } catch (err) {
      nextPlayer.dispose();
      setSnapshot(previousPlayer.getSnapshot());
      throw err;
    }

    const previousSnapshot = previousPlayer.getSnapshot();
    const wasPlaying = previousSnapshot.status === "playing";
    const resumePositionMs = previousSnapshot.positionMs;

    playerUnsubscribeRef.current?.();
    playerDiagnosticsUnsubscribeRef.current?.();
    previousPlayer.dispose();
    playerModeRef.current = mode;
    playerRef.current = nextPlayer;
    playerUnsubscribeRef.current = nextPlayer.subscribe(commitPlayerSnapshot);
    playerDiagnosticsUnsubscribeRef.current = nextPlayer.subscribeDiagnostics(setPlayerDiagnostics);

    if (!options.reloadCurrentSong || !loadInput) {
      return;
    }

    nextPlayer.seek(resumePositionMs);
    if (wasPlaying) {
      await nextPlayer.play();
    }
  }

  function commitSettings(nextSettings: UserSettings) {
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
  }

  function commitPlayerSnapshot(nextSnapshot: PlayerSnapshot) {
    setSnapshot((previousSnapshot) => {
      if (!shouldCommitPlayerSnapshot(previousSnapshot, nextSnapshot)) {
        return previousSnapshot;
      }

      snapshotStatusRef.current = nextSnapshot.status;
      setRuntimeDiagnostics((previousDiagnostics) => ({
        ...previousDiagnostics,
        snapshotCommitCount: previousDiagnostics.snapshotCommitCount + 1
      }));
      return nextSnapshot;
    });
  }

  function cancelPendingPlayerDispose() {
    if (playerDisposeTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(playerDisposeTimeoutRef.current);
    playerDisposeTimeoutRef.current = null;
  }

  function schedulePlayerDispose() {
    cancelPendingPlayerDispose();

    const playerToDispose = playerRef.current;
    playerDisposeTimeoutRef.current = window.setTimeout(() => {
      if (playerRef.current === playerToDispose) {
        playerToDispose.dispose();
      }

      playerDisposeTimeoutRef.current = null;
    }, 0);
  }

  const isPlayerBusy =
    snapshot.status === "loading-soundfont" || snapshot.status === "loading-midi";
  const isPlayerUnavailable = isPlayerBusy || snapshot.status === "error";

  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">midi-studio</p>
          <h1>MIDI 五线谱播放器</h1>
        </div>
        <div className="top-actions">
          <button
            className="button secondary"
            type="button"
            onClick={() => setView(view === "settings" ? "player" : "settings")}
          >
            {view === "settings" ? "播放器" : "设置"}
          </button>
          <button className="button secondary" type="button" onClick={() => fileInputRef.current?.click()}>
            打开 MIDI
          </button>
          <input
            ref={fileInputRef}
            className="file-input"
            type="file"
            accept=".mid,.midi,audio/midi"
            onChange={handleFileChange}
          />
        </div>
      </header>

      {view === "settings" ? (
        <SettingsPage
          error={settingsError}
          isSaving={isSavingSettings}
          settings={settings}
          storageInfo={storageInfo}
          onBack={() => setView("player")}
          onUpdate={updateSettings}
        />
      ) : (
        <>
          <section className="workspace">
            <aside className="sidebar">
              <dl className="song-meta">
                <div>
                  <dt>曲目</dt>
                  <dd>{song?.title ?? "未载入"}</dd>
                </div>
                <div>
                  <dt>调性</dt>
                  <dd>{song?.keyName ?? "-"}</dd>
                </div>
                <div>
                  <dt>BPM</dt>
                  <dd>{song?.bpm ? Math.round(song.bpm) : "-"}</dd>
                </div>
                <div>
                  <dt>轨道</dt>
                  <dd>{song?.trackCount ?? "-"}</dd>
                </div>
                <div>
                  <dt>音符</dt>
                  <dd>{song?.noteCount ?? "-"}</dd>
                </div>
                <div>
                  <dt>播放模式</dt>
                  <dd>{settings.playbackEngineMode === "sf2-synth" ? "SF2 合成" : "纯 MIDI"}</dd>
                </div>
                <div>
                  <dt>播放器状态</dt>
                  <dd>{formatPlayerStatus(snapshot)}</dd>
                </div>
              </dl>
              <PlaybackDiagnosticsPanel
                playerDiagnostics={playerDiagnostics}
                runtimeDiagnostics={runtimeDiagnostics}
              />
              {error ? <p className="error-text">{error}</p> : null}
              {settingsError ? <p className="error-text">{settingsError}</p> : null}
            </aside>

            <section className="notation-panel" aria-label="五线谱">
              {song ? (
                <StaffNotationPanel
                  isRendering={scoreRenderState.status === "rendering"}
                  getPlaybackPosition={getPlaybackPosition}
                  playbackMap={scoreRenderState.playbackMap}
                  renderError={scoreRenderState.error}
                  renderScore={scoreRenderState.renderScore}
                  score={scoreRenderState.score}
                  onPlaybackMetrics={recordOverlayMetrics}
                  onSeek={seekTo}
                />
              ) : (
                <div className="empty-state">
                  <strong>打开一个 MIDI 文件</strong>
                  <span>支持 .mid 和 .midi</span>
                </div>
              )}
            </section>
        </section>

          <footer className="transport">
            <div className="transport-row">
              <button
                className="button primary play-button"
                type="button"
                onClick={togglePlay}
                disabled={Boolean(song) && isPlayerUnavailable}
              >
                {snapshot.status === "playing" ? "暂停" : "播放"}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={stopPlayback}
                disabled={!song || isPlayerBusy}
              >
                停止
              </button>
              <PlaybackClockReadout
                durationMs={song?.durationMs ?? 0}
                getPlaybackPosition={getPlaybackPosition}
                status={snapshot.status}
              />
              <label className="speed-control">
                <span>速度</span>
                <input
                  type="range"
                  min="50"
                  max="150"
                  step="5"
                  value={speed}
                  disabled={!song || isPlayerUnavailable}
                  onChange={(event) => changeSpeed(Number(event.currentTarget.value))}
                />
                <strong>{speed}%</strong>
              </label>
            </div>
            <PlaybackProgressControl
              disabled={!song || isPlayerUnavailable}
              durationMs={song?.durationMs ?? 0}
              getPlaybackPosition={getPlaybackPosition}
              status={snapshot.status}
              onSeek={seekTo}
            />
          </footer>
        </>
      )}
    </main>
  );
}

function PlaybackDiagnosticsPanel({
  playerDiagnostics,
  runtimeDiagnostics
}: {
  playerDiagnostics: PlayerDiagnostics;
  runtimeDiagnostics: PlaybackRuntimeDiagnostics;
}) {
  return (
    <section className="playback-diagnostics" aria-label="播放诊断">
      <h2>播放诊断</h2>
      <dl>
        <div>
          <dt>输出</dt>
          <dd>{formatOutputMode(playerDiagnostics.outputMode)}</dd>
        </div>
        <div>
          <dt>脚本</dt>
          <dd>{formatDuration(playerDiagnostics.alphaSynthScriptLoadMs)}</dd>
        </div>
        <div>
          <dt>Synth</dt>
          <dd>{formatDuration(playerDiagnostics.synthReadyMs)}</dd>
        </div>
        <div>
          <dt>SF2</dt>
          <dd>{formatDuration(playerDiagnostics.soundFontLoadMs)}</dd>
        </div>
        <div>
          <dt>MIDI</dt>
          <dd>{formatDuration(playerDiagnostics.midiLoadMs)}</dd>
        </div>
        <div>
          <dt>解析</dt>
          <dd>{formatDuration(runtimeDiagnostics.midiParseWorkerMs)}</dd>
        </div>
        <div>
          <dt>谱面</dt>
          <dd>{formatDuration(runtimeDiagnostics.scoreRenderWorkerMs)}</dd>
        </div>
        <div>
          <dt>Long task</dt>
          <dd>
            {runtimeDiagnostics.longTaskCount} / {formatDuration(runtimeDiagnostics.longestLongTaskMs)}
          </dd>
        </div>
        <div>
          <dt>Snapshot</dt>
          <dd>{runtimeDiagnostics.snapshotCommitCount}</dd>
        </div>
        <div>
          <dt>Overlay</dt>
          <dd>
            {runtimeDiagnostics.overlayUpdateCount} / {formatDuration(runtimeDiagnostics.overlayLookupMs)} /{" "}
            {runtimeDiagnostics.overlayEventCount}
          </dd>
        </div>
        <div>
          <dt>错误</dt>
          <dd>
            {playerDiagnostics.lastErrorType ??
              runtimeDiagnostics.midiParseError ??
              runtimeDiagnostics.scoreRenderError ??
              "-"}
          </dd>
        </div>
      </dl>
      {playerDiagnostics.fallbackReason ? (
        <p>{playerDiagnostics.fallbackReason}</p>
      ) : null}
      {runtimeDiagnostics.midiParseError ? (
        <p>{runtimeDiagnostics.midiParseError}</p>
      ) : null}
      {runtimeDiagnostics.scoreRenderError ? (
        <p>{runtimeDiagnostics.scoreRenderError}</p>
      ) : null}
    </section>
  );
}

function PlaybackClockReadout({
  durationMs,
  getPlaybackPosition,
  status
}: {
  durationMs: number;
  getPlaybackPosition: () => number;
  status: PlayerSnapshot["status"];
}) {
  const positionRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    function updateClock() {
      if (positionRef.current) {
        positionRef.current.textContent = formatTime(getPlaybackPosition());
      }
    }

    updateClock();
    const intervalId = window.setInterval(updateClock, PLAYBACK_SNAPSHOT_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [durationMs, getPlaybackPosition, status]);

  return (
    <div className="time-readout">
      <span ref={positionRef}>{formatTime(getPlaybackPosition())}</span>
      <span>/</span>
      <span>{formatTime(durationMs)}</span>
    </div>
  );
}

function PlaybackProgressControl({
  disabled,
  durationMs,
  getPlaybackPosition,
  status,
  onSeek
}: {
  disabled: boolean;
  durationMs: number;
  getPlaybackPosition: () => number;
  status: PlayerSnapshot["status"];
  onSeek: (positionMs: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function updateProgress() {
      const positionMs = getPlaybackPosition();
      const progressPercent = durationMs ? Math.min(100, (positionMs / durationMs) * 100) : 0;

      if (inputRef.current && document.activeElement !== inputRef.current) {
        inputRef.current.value = String(Math.round(positionMs));
      }

      if (fillRef.current) {
        fillRef.current.style.width = `${progressPercent}%`;
      }
    }

    updateProgress();
    const intervalId = window.setInterval(updateProgress, PLAYBACK_SNAPSHOT_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [durationMs, getPlaybackPosition, status]);

  return (
    <div className="progress-wrap">
      <input
        ref={inputRef}
        className="progress-input"
        type="range"
        min="0"
        max={Math.max(1, Math.round(durationMs || 1))}
        step="1"
        defaultValue={Math.round(getPlaybackPosition())}
        disabled={disabled}
        onChange={(event) => onSeek(Number(event.currentTarget.value))}
        aria-label="播放进度"
      />
      <div ref={fillRef} className="progress-fill" />
    </div>
  );
}

function parseMidiInWorker(
  buffer: ArrayBuffer,
  fileName: string,
  requestId: number
): Promise<MidiParseResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./workers/midiParseWorker.ts", import.meta.url), {
      type: "module"
    });

    function cleanup() {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }

    worker.onmessage = (event: MessageEvent<MidiParseResponse>) => {
      if (event.data.requestId !== requestId) {
        return;
      }

      cleanup();
      if (event.data.status === "success") {
        resolve({
          song: event.data.song,
          durationMs: event.data.durationMs
        });
      } else {
        reject(createTimedWorkerError(event.data.message, event.data.durationMs));
      }
    };

    worker.onerror = (event) => {
      cleanup();
      reject(new Error(event.message || "MIDI 解析线程失败。"));
    };

    const request: MidiParseRequest = { requestId, buffer, fileName };
    worker.postMessage(request, [buffer]);
  });
}

function createTimedWorkerError(message: string, durationMs: number): Error {
  const error = new Error(message);

  (error as Error & { durationMs?: number }).durationMs = durationMs;
  return error;
}

function getTimedWorkerErrorDuration(error: unknown): number | undefined {
  if (
    error &&
    typeof error === "object" &&
    "durationMs" in error &&
    typeof error.durationMs === "number"
  ) {
    return error.durationMs;
  }

  return undefined;
}

function areSnapshotsEqual(left: PlayerSnapshot, right: PlayerSnapshot): boolean {
  return (
    left.status === right.status &&
    left.durationMs === right.durationMs &&
    Math.round(left.positionMs) === Math.round(right.positionMs)
  );
}

function shouldCommitPlayerSnapshot(left: PlayerSnapshot, right: PlayerSnapshot): boolean {
  if (
    left.status !== right.status ||
    left.durationMs !== right.durationMs ||
    left.loadingMessage !== right.loadingMessage ||
    left.error !== right.error
  ) {
    return true;
  }

  if (right.status !== "playing") {
    return !areSnapshotsEqual(left, right);
  }

  return false;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }

  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}s`;
  }

  return `${Math.round(value)}ms`;
}

function formatOutputMode(outputMode: PlayerDiagnostics["outputMode"]): string {
  switch (outputMode) {
    case "audio-worklet":
      return "AudioWorklet";
    case "script-processor":
      return "ScriptProcessor";
    case "pure-web-audio":
      return "纯 WebAudio";
    case "unknown":
    default:
      return "-";
  }
}

function formatPlayerStatus(snapshot: PlayerSnapshot): string {
  switch (snapshot.status) {
    case "loading-soundfont":
    case "loading-midi":
      return snapshot.loadingMessage ?? "加载中";
    case "ready":
      return "已就绪";
    case "playing":
      return "播放中";
    case "paused":
      return "已暂停";
    case "ended":
      return "已结束";
    case "error":
      return snapshot.error ?? "播放器错误";
    case "idle":
    default:
      return "待机";
  }
}
