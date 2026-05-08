import type { ParsedSong } from "../midi";

export type MusicXmlImportDiagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  partId?: string;
  measureIndex?: number;
  tick?: number;
};

export type MusicXmlImportResult = {
  song: ParsedSong;
  midiBytes: ArrayBuffer;
  diagnostics: MusicXmlImportDiagnostic[];
  sourceFormat: "xml" | "mxl";
};

