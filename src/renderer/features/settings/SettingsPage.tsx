import type {
  PlaybackEngineMode,
  SettingsStorageInfo,
  UserSettings
} from "../../../shared/settings";

type SettingsPageProps = {
  settings: UserSettings;
  storageInfo: SettingsStorageInfo | null;
  isSaving: boolean;
  error: string;
  onBack: () => void;
  onUpdate: (patch: Partial<UserSettings>) => Promise<void>;
};

export function SettingsPage({
  settings,
  storageInfo,
  isSaving,
  error,
  onBack,
  onUpdate
}: SettingsPageProps) {
  return (
    <main className="settings-page">
      <section className="settings-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>应用设置</h2>
        </div>
        <button className="button secondary" type="button" onClick={onBack}>
          返回播放器
        </button>
      </section>

      <section className="settings-section">
        <div className="settings-copy">
          <h3>播放模式</h3>
          <p>选择默认 MIDI 播放引擎。SF2 合成会加载本地 SoundFont，音色更接近真实钢琴。</p>
        </div>
        <div className="segmented-control" aria-label="播放模式">
          <ModeButton
            active={settings.playbackEngineMode === "basic-midi"}
            disabled={isSaving}
            label="纯 MIDI"
            onClick={() => onUpdate({ playbackEngineMode: "basic-midi" })}
          />
          <ModeButton
            active={settings.playbackEngineMode === "sf2-synth"}
            disabled={isSaving}
            label="SF2 合成"
            onClick={() => onUpdate({ playbackEngineMode: "sf2-synth" })}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-copy">
          <h3>谱面渲染</h3>
          <p>新版渲染器使用统一 SVG engraving 样式；经典渲染器保留旧的 JSX 绘制路径。</p>
        </div>
        <div className="segmented-control" aria-label="谱面渲染">
          <ModeButton
            active={settings.notationRendererMode === "engraved"}
            disabled={isSaving}
            label="Engraved SVG"
            onClick={() => onUpdate({ notationRendererMode: "engraved" })}
          />
          <ModeButton
            active={settings.notationRendererMode === "classic"}
            disabled={isSaving}
            label="Classic JSX"
            onClick={() => onUpdate({ notationRendererMode: "classic" })}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-copy">
          <h3>默认速度</h3>
          <p>打开新 MIDI 文件时使用的初始播放速度。</p>
        </div>
        <label className="settings-slider">
          <input
            type="range"
            min="50"
            max="150"
            step="5"
            value={settings.defaultSpeedPercent}
            disabled={isSaving}
            onChange={(event) =>
              onUpdate({ defaultSpeedPercent: Number(event.currentTarget.value) })
            }
          />
          <strong>{settings.defaultSpeedPercent}%</strong>
        </label>
      </section>

      <section className="settings-section">
        <div className="settings-copy">
          <h3>主音量</h3>
          <p>控制当前播放器和后续打开曲目的默认音量。</p>
        </div>
        <label className="settings-slider">
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={settings.masterVolumePercent}
            disabled={isSaving}
            onChange={(event) =>
              onUpdate({ masterVolumePercent: Number(event.currentTarget.value) })
            }
          />
          <strong>{settings.masterVolumePercent}%</strong>
        </label>
      </section>

      <section className="settings-section">
        <div className="settings-copy">
          <h3>跟随播放</h3>
          <p>播放时自动让谱面跟随当前进度。</p>
        </div>
        <label className="toggle-control">
          <input
            type="checkbox"
            checked={settings.followPlayback}
            disabled={isSaving}
            onChange={(event) => onUpdate({ followPlayback: event.currentTarget.checked })}
          />
          <span>{settings.followPlayback ? "开启" : "关闭"}</span>
        </label>
      </section>

      <section className="settings-section storage-section">
        <div className="settings-copy">
          <h3>数据存储</h3>
          <p>设置会保存到 SQLite 数据库。portable 版本会使用 exe 同级 data 目录。</p>
        </div>
        <dl className="storage-info">
          <div>
            <dt>数据目录</dt>
            <dd>{storageInfo?.dataDir ?? "读取中"}</dd>
          </div>
          <div>
            <dt>SQLite 文件</dt>
            <dd>{storageInfo?.dbPath ?? "读取中"}</dd>
          </div>
        </dl>
      </section>

      {error ? <p className="settings-error">{error}</p> : null}
    </main>
  );
}

type ModeButtonProps = {
  active: boolean;
  disabled: boolean;
  label: string;
  onClick: () => void;
};

function ModeButton({ active, disabled, label, onClick }: ModeButtonProps) {
  return (
    <button
      className={`segment-button${active ? " active" : ""}`}
      type="button"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
