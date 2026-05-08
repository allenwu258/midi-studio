import type { ParsedSong } from "../lib/midi";
import type { MusicXmlImportDiagnostic } from "../lib/musicxml";
import type { ScoreDraft } from "../lib/score";

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
  score: ScoreDraft;
  diagnostics: MusicXmlImportDiagnostic[];
};

export type MusicXmlParseFailure = {
  requestId: number;
  status: "error";
  durationMs: number;
  message: string;
};

export type MusicXmlParseResponse = MusicXmlParseSuccess | MusicXmlParseFailure;
