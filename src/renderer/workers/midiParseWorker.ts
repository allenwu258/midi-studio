import { parseMidiFile } from "../lib/midi";
import type { MidiParseRequest, MidiParseResponse } from "./midiParseMessages";

type MidiParseWorkerScope = {
  postMessage(message: MidiParseResponse): void;
  onmessage: ((event: MessageEvent<MidiParseRequest>) => void) | null;
};

const workerScope = self as unknown as MidiParseWorkerScope;

workerScope.onmessage = (event) => {
  const { requestId, buffer, fileName } = event.data;

  try {
    workerScope.postMessage({
      requestId,
      status: "success",
      song: parseMidiFile(buffer, fileName)
    });
  } catch (error) {
    workerScope.postMessage({
      requestId,
      status: "error",
      message: error instanceof Error ? error.message : "MIDI 解析失败。"
    });
  }
};
