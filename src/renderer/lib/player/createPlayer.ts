import { SynthPlayer } from "../synthPlayer";
import { AlphaSynthPlayer } from "./alphaSynthPlayer";
import type { MidiPlaybackEngine, PlayerFactoryOptions } from "./types";

export function createPlayer({ mode }: PlayerFactoryOptions): MidiPlaybackEngine {
  if (mode === "sf2-synth") {
    return new AlphaSynthPlayer();
  }

  return new SynthPlayer();
}
