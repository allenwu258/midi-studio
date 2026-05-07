import type { ParsedSong } from "../lib/midi";

export type MidiParseRequest = {
  requestId: number;
  buffer: ArrayBuffer;
  fileName: string;
};

export type MidiParseSuccess = {
  requestId: number;
  status: "success";
  durationMs: number;
  song: ParsedSong;
};

export type MidiParseFailure = {
  requestId: number;
  status: "error";
  durationMs: number;
  message: string;
};

export type MidiParseResponse = MidiParseSuccess | MidiParseFailure;
