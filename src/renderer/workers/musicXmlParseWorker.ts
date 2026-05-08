import { parseMusicXmlFile } from "../lib/musicxml";
import type { MusicXmlParseRequest, MusicXmlParseResponse } from "./musicXmlParseMessages";

type MusicXmlParseWorkerScope = {
  postMessage(message: MusicXmlParseResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MusicXmlParseRequest>) => void) | null;
};

const workerScope = self as unknown as MusicXmlParseWorkerScope;

workerScope.onmessage = (event) => {
  const { requestId, buffer, fileName } = event.data;
  const startedAt = performance.now();

  parseMusicXmlFile(buffer, fileName)
    .then((result) => {
      workerScope.postMessage(
        {
          requestId,
          status: "success",
          durationMs: performance.now() - startedAt,
          sourceFormat: result.sourceFormat,
          song: result.song,
          midiBytes: result.midiBytes,
          diagnostics: result.diagnostics
        },
        [result.midiBytes]
      );
    })
    .catch((error) => {
      workerScope.postMessage({
        requestId,
        status: "error",
        durationMs: performance.now() - startedAt,
        message: error instanceof Error ? error.message : "MusicXML 解析失败。"
      });
    });
};

