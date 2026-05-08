import type { ParsedSong } from "../lib/midi";
import type { MusicXmlImportDiagnostic } from "../lib/musicxml";

export type MusicXmlParseRequest = {
  requestId: number;
  buffer: ArrayBuffer;
  fileName: string;
};

export type MusicXmlParseSuccess = {
  requestId: number;
  status: "success";
  durationMs: number;
  sourceFormat: "xml" | "mxl";
  song: ParsedSong;
  midiBytes: ArrayBuffer;
  diagnostics: MusicXmlImportDiagnostic[];
};

export type MusicXmlParseFailure = {
  requestId: number;
  status: "error";
  durationMs: number;
  message: string;
};

export type MusicXmlParseResponse = MusicXmlParseSuccess | MusicXmlParseFailure;

