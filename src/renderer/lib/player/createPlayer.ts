import { SynthPlayer } from "../synthPlayer";
import { AlphaSynthPlayer } from "./alphaSynthPlayer";
import type { MidiPlaybackEngine, PlayerFactoryOptions } from "./types";

export function createPlayer({
  mode,
  masterVolumePercent = 100
}: PlayerFactoryOptions): MidiPlaybackEngine {
  const player = mode === "sf2-synth" ? new AlphaSynthPlayer() : new SynthPlayer();
  player.setMasterVolume(masterVolumePercent);
  return player;
}
