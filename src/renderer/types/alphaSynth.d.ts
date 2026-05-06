export type AlphaSynthEvent<T = void> = {
  on(listener: (event: T) => void): void;
};

export type AlphaSynthPositionEvent = {
  currentTime?: number;
  endTime?: number;
  currentTick?: number;
  endTick?: number;
  isSeek?: boolean;
};

export type AlphaSynthStateEvent = {
  state: number;
  stopped?: boolean;
};

export type AlphaSynthApi = {
  ready: AlphaSynthEvent;
  readyForPlayback: AlphaSynthEvent;
  finished: AlphaSynthEvent;
  soundFontLoaded: AlphaSynthEvent;
  soundFontLoadFailed: AlphaSynthEvent<unknown>;
  midiLoaded: AlphaSynthEvent<AlphaSynthPositionEvent>;
  midiLoadFailed: AlphaSynthEvent<unknown>;
  stateChanged: AlphaSynthEvent<AlphaSynthStateEvent>;
  positionChanged: AlphaSynthEvent<AlphaSynthPositionEvent>;
  playbackRangeChanged: AlphaSynthEvent<unknown>;
  setMasterVolume(volume: number): void;
  setPlaybackSpeed(speed: number): void;
  setTimePosition(positionMs: number): void;
  loadMidiFile(midi: ArrayBuffer | Uint8Array | string): void;
  play(): void;
  pause(): void;
  stop(): void;
  destroy(): void;
};

export type AlphaSynthSettings = {
  soundFont: string | null;
  bufferTimeInMilliseconds: number;
  logLevel: number;
  outputMode: number;
};

declare global {
  interface Window {
    alphaSynth?: {
      Settings: new () => AlphaSynthSettings;
      AlphaSynthApi: new (settings: AlphaSynthSettings) => AlphaSynthApi;
      LogLevel: {
        None: number;
      };
      PlayerOutputMode: {
        WebAudioScriptProcessor: number;
      };
    };
  }
}

export {};
