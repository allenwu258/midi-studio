import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SETTINGS, type SettingsStorageInfo, type UserSettings } from "../shared/settings";
import { SettingsPage } from "./features/settings/SettingsPage";
import { parseMidiFile, type NoteCluster, type ParsedSong } from "./lib/midi";
import { formatTime } from "./lib/notation";
import { createPlayer } from "./lib/player/createPlayer";
import type {
  MidiPlaybackEngine,
  PlayerLoadInput,
  PlayerSnapshot
} from "./lib/player/types";

type AppView = "player" | "settings";

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
  const playerDisposeTimeoutRef = useRef<number | null>(null);
  const currentLoadInputRef = useRef<PlayerLoadInput | null>(null);
  const loadGenerationRef = useRef(0);
  const settingsRef = useRef<UserSettings>(DEFAULT_SETTINGS);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingSettingsSaveCountRef = useRef(0);
  const [song, setSong] = useState<ParsedSong | null>(null);
  const [snapshot, setSnapshot] = useState<PlayerSnapshot>(() => playerRef.current.getSnapshot());
  const [speed, setSpeed] = useState(100);
  const [error, setError] = useState("");
  const [view, setView] = useState<AppView>("player");
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [storageInfo, setStorageInfo] = useState<SettingsStorageInfo | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  useEffect(() => {
    cancelPendingPlayerDispose();
    playerUnsubscribeRef.current = playerRef.current.subscribe(setSnapshot);
    const intervalId = window.setInterval(() => {
      const nextSnapshot = playerRef.current.getSnapshot();

      setSnapshot((previousSnapshot) =>
        areSnapshotsEqual(previousSnapshot, nextSnapshot) ? previousSnapshot : nextSnapshot
      );
    }, 33);

    return () => {
      playerUnsubscribeRef.current?.();
      playerUnsubscribeRef.current = null;
      window.clearInterval(intervalId);
      schedulePlayerDispose();
    };
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

  const clusterPlayback = useMemo(() => {
    return song ? findClusterPlayback(song.clusters, snapshot.positionMs) : { activeIndex: -1, pastIndex: -1 };
  }, [snapshot.positionMs, song]);

  const progressPercent = song?.durationMs
    ? Math.min(100, (snapshot.positionMs / song.durationMs) * 100)
    : 0;

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }

    let loadGeneration = loadGenerationRef.current;
    let loadingPlayer = playerRef.current;

    try {
      setError("");
      const buffer = await file.arrayBuffer();
      const midiBytes = buffer.slice(0);
      const parsedSong = parseMidiFile(buffer, file.name);
      const loadInput = {
        midiBytes,
        notes: parsedSong.notes,
        durationMs: parsedSong.durationMs
      };

      loadGeneration = loadGenerationRef.current + 1;
      loadingPlayer = playerRef.current;
      loadGenerationRef.current = loadGeneration;
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
    previousPlayer.dispose();
    playerModeRef.current = mode;
    playerRef.current = nextPlayer;
    playerUnsubscribeRef.current = nextPlayer.subscribe(setSnapshot);

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
          <h1>简谱 MIDI 播放器</h1>
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
              {error ? <p className="error-text">{error}</p> : null}
              {settingsError ? <p className="error-text">{settingsError}</p> : null}
            </aside>

            <section className="notation-panel" aria-label="简谱">
              {song ? (
                <NumberedNotation
                  activeClusterIndex={clusterPlayback.activeIndex}
                  clusters={song.clusters}
                  pastClusterIndex={clusterPlayback.pastIndex}
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
              <div className="time-readout">
                <span>{formatTime(snapshot.positionMs)}</span>
                <span>/</span>
                <span>{formatTime(song?.durationMs ?? 0)}</span>
              </div>
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
            <div className="progress-wrap">
              <input
                className="progress-input"
                type="range"
                min="0"
                max={Math.max(1, Math.round(song?.durationMs ?? 1))}
                step="1"
                value={Math.round(snapshot.positionMs)}
                disabled={!song || isPlayerUnavailable}
                onChange={(event) => seekTo(Number(event.currentTarget.value))}
                aria-label="播放进度"
              />
              <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </footer>
        </>
      )}
    </main>
  );
}

type NumberedNotationProps = {
  clusters: NoteCluster[];
  activeClusterIndex: number;
  pastClusterIndex: number;
};

function NumberedNotation({ clusters, activeClusterIndex, pastClusterIndex }: NumberedNotationProps) {
  return (
    <div className="numbered-score">
      {clusters.map((cluster, index) => (
        <NoteToken
          key={cluster.id}
          cluster={cluster}
          isActive={index === activeClusterIndex}
          isPast={index <= pastClusterIndex && index !== activeClusterIndex}
        />
      ))}
    </div>
  );
}

type NoteTokenProps = {
  cluster: NoteCluster;
  isActive: boolean;
  isPast: boolean;
};

const NoteToken = memo(function NoteToken({ cluster, isActive, isPast }: NoteTokenProps) {
  return (
    <span
      className={`note-token${isActive ? " active" : ""}${isPast ? " past" : ""}`}
      title={`${formatTime(cluster.startMs)} ${cluster.notes.map((note) => note.name).join(" ")}`}
    >
      {cluster.label}
    </span>
  );
});

function findClusterPlayback(
  clusters: NoteCluster[],
  positionMs: number
): { activeIndex: number; pastIndex: number } {
  let low = 0;
  let high = clusters.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);

    if (clusters[mid].startMs <= positionMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate < 0) {
    return { activeIndex: -1, pastIndex: -1 };
  }

  const cluster = clusters[candidate];
  const isActive = positionMs <= Math.max(cluster.endMs, cluster.startMs + 180);

  return {
    activeIndex: isActive ? candidate : -1,
    pastIndex: cluster.endMs < positionMs ? candidate : candidate - 1
  };
}

function areSnapshotsEqual(left: PlayerSnapshot, right: PlayerSnapshot): boolean {
  return (
    left.status === right.status &&
    left.durationMs === right.durationMs &&
    Math.round(left.positionMs) === Math.round(right.positionMs)
  );
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
