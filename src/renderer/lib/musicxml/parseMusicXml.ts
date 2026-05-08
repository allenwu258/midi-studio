import JSZip from "jszip";
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import { buildMidiBytes } from "./midiWriter";
import type { MidiNote, ParsedMidiMeta, ParsedSong, ParsedTrack } from "../midi";
import type { MusicXmlImportDiagnostic, MusicXmlImportResult } from "./types";

const DEFAULT_PPQ = 480;
const DEFAULT_BPM = 120;
const FALLBACK_TIME_SIGNATURE = { numerator: 4, denominator: 4 };
const FALLBACK_KEY_SIGNATURE = { key: "C", scale: "major" };

type PartInfo = {
  id: string;
  name: string;
  instrumentName: string;
  channel: number | null;
  program: number;
  isDrum: boolean;
};

type ParsedMeasureState = {
  startTicks: number;
  lengthTicks: number;
  divisions: number;
  timeSignature: { numerator: number; denominator: number };
};

type PendingTempo = {
  ticks: number;
  bpm: number;
};

type PendingTimeSignature = {
  ticks: number;
  numerator: number;
  denominator: number;
};

type PendingKeySignature = {
  ticks: number;
  key: string;
  scale: string;
};

export async function parseMusicXmlFile(buffer: ArrayBuffer, fileName: string): Promise<MusicXmlImportResult> {
  const { xmlText, sourceFormat } = await readMusicXmlText(buffer, fileName);
  const document = parseXmlDocument(xmlText, fileName);
  const diagnostics: MusicXmlImportDiagnostic[] = [];
  const song = parseMusicXmlDocument(document, fileName, diagnostics);

  return {
    song,
    midiBytes: buildMidiBytes(song),
    diagnostics,
    sourceFormat
  };
}

async function readMusicXmlText(
  buffer: ArrayBuffer,
  fileName: string
): Promise<{ xmlText: string; sourceFormat: "xml" | "mxl" }> {
  if (!looksLikeZip(buffer) && !fileName.toLowerCase().endsWith(".mxl")) {
    return {
      xmlText: new TextDecoder().decode(buffer),
      sourceFormat: "xml"
    };
  }

  const zip = await JSZip.loadAsync(buffer);
  const containerText = await readZipText(zip, "META-INF/container.xml");
  if (!containerText) {
    throw new Error("MXL 缺少 META-INF/container.xml。");
  }

  const containerDoc = parseXmlDocument(containerText, "META-INF/container.xml");
  const rootfile = findFirstText(containerDoc.documentElement, "rootfile", "full-path");
  if (!rootfile) {
    throw new Error("MXL 容器未找到 rootfile。");
  }

  const xmlText = await readZipText(zip, rootfile);
  if (!xmlText) {
    throw new Error(`MXL 未找到根文件：${rootfile}`);
  }

  return { xmlText, sourceFormat: "mxl" };
}

function parseMusicXmlDocument(
  document: Document,
  fileName: string,
  diagnostics: MusicXmlImportDiagnostic[]
): ParsedSong {
  const root = document.documentElement;
  if (!root || root.nodeName !== "score-partwise") {
    throw new Error("仅支持 MusicXML score-partwise 文件。");
  }

  const ppq = computeResolution(root);
  const partInfos = parsePartInfos(root);
  const parts = Array.from(root.children).filter((child) => child.nodeName === "part") as Element[];
  const notes: MidiNote[] = [];
  const tracks: ParsedTrack[] = [];
  const tempos: PendingTempo[] = [];
  const timeSignatures: PendingTimeSignature[] = [];
  const keySignatures: PendingKeySignature[] = [];
  let durationTicks = 0;

  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const partElement = parts[partIndex];
    const partId = partElement.getAttribute("id") ?? `P${partIndex + 1}`;
    const partInfo = partInfos.get(partId) ?? createFallbackPartInfo(partId, partIndex);
    const partResult = parsePart(
      partElement,
      partIndex,
      partInfo,
      ppq,
      tempos,
      timeSignatures,
      keySignatures,
      diagnostics
    );

    tracks.push(partResult.track);
    notes.push(...partResult.notes);
    durationTicks = Math.max(durationTicks, partResult.durationTicks);
  }

  if (!notes.length) {
    throw new Error("这个 MusicXML 没有可播放的音符事件。");
  }

  notes.sort((a, b) => a.startTicks - b.startTicks || a.midi - b.midi);

  const normalizedTempos = normalizeTempos(tempos, durationTicks);
  const normalizedTimeSignatures = normalizeTimeSignatures(timeSignatures, durationTicks);
  const normalizedKeySignatures = normalizeKeySignatures(keySignatures);
  const meta: ParsedMidiMeta = {
    ppq,
    durationTicks,
    tempos: normalizedTempos,
    timeSignatures: normalizedTimeSignatures,
    keySignatures: normalizedKeySignatures
  };
  applyNoteTimes(notes, normalizedTempos, ppq);
  const song: ParsedSong = {
    id: `${fileName}-${Date.now()}`,
    fileName,
    title: findScoreTitle(root) || stripExtension(fileName) || "Untitled MusicXML",
    keyName: formatKeyName(normalizedKeySignatures[0] ?? FALLBACK_KEY_SIGNATURE),
    bpm: normalizedTempos[0]?.bpm ?? null,
    durationMs: ticksToMs(durationTicks, normalizedTempos, ppq),
    trackCount: tracks.length,
    noteCount: notes.length,
    notes,
    tracks,
    meta
  };

  return song;
}

function applyNoteTimes(notes: MidiNote[], tempos: ParsedMidiMeta["tempos"], ppq: number): void {
  for (const note of notes) {
    const startMs = ticksToMs(note.startTicks, tempos, ppq);
    const endMs = ticksToMs(note.endTicks, tempos, ppq);

    note.startMs = startMs;
    note.endMs = endMs;
    note.durationMs = Math.max(40, endMs - startMs);
  }
}

function parsePart(
  partElement: Element,
  partIndex: number,
  partInfo: PartInfo,
  ppq: number,
  tempos: PendingTempo[],
  timeSignatures: PendingTimeSignature[],
  keySignatures: PendingKeySignature[],
  diagnostics: MusicXmlImportDiagnostic[]
): { track: ParsedTrack; notes: MidiNote[]; durationTicks: number } {
  const notes: MidiNote[] = [];
  const measureElements = Array.from(partElement.children).filter((child) => child.nodeName === "measure") as Element[];
  const resolvedPartInfo = {
    ...partInfo,
    isDrum: partInfo.isDrum || partElement.getElementsByTagName("unpitched").length > 0
  };
  let measureStartTicks = 0;
  let currentDivisions = 1;
  let currentTimeSignature = { ...FALLBACK_TIME_SIGNATURE };
  let maxTick = 0;

  for (let measureIndex = 0; measureIndex < measureElements.length; measureIndex += 1) {
    const measureElement = measureElements[measureIndex];
    const measureState: ParsedMeasureState = {
      startTicks: measureStartTicks,
      lengthTicks: ticksPerMeasure(ppq, currentTimeSignature.numerator, currentTimeSignature.denominator),
      divisions: currentDivisions,
      timeSignature: { ...currentTimeSignature }
    };
    const parseResult = parseMeasure(
      measureElement,
      partIndex,
      resolvedPartInfo,
      measureIndex,
      measureState,
      ppq,
      tempos,
      timeSignatures,
      keySignatures,
      diagnostics
    );

    notes.push(...parseResult.notes);
    maxTick = Math.max(maxTick, parseResult.maxTick);

    currentDivisions = parseResult.nextDivisions;
    currentTimeSignature = parseResult.nextTimeSignature;
    measureStartTicks += measureState.lengthTicks;
  }

  const partNotes = notes.filter((note) => note.trackIndex === partIndex);
  const trackChannel = resolvedPartInfo.channel ?? allocateChannel(partIndex, resolvedPartInfo.isDrum);
  const track: ParsedTrack = {
    index: partIndex,
    name: resolvedPartInfo.name,
    channel: trackChannel,
    program: resolvedPartInfo.program,
    instrumentName: resolvedPartInfo.instrumentName,
    isDrum: resolvedPartInfo.isDrum,
    noteCount: partNotes.length
  };

  for (const note of partNotes) {
    note.channel = trackChannel;
    note.program = resolvedPartInfo.program;
    note.instrumentName = resolvedPartInfo.instrumentName;
    note.isDrum = resolvedPartInfo.isDrum;
  }

  return {
    track,
    notes: partNotes,
    durationTicks: maxTick
  };
}

function parseMeasure(
  measureElement: Element,
  partIndex: number,
  partInfo: PartInfo,
  measureIndex: number,
  measureState: ParsedMeasureState,
  ppq: number,
  tempos: PendingTempo[],
  timeSignatures: PendingTimeSignature[],
  keySignatures: PendingKeySignature[],
  diagnostics: MusicXmlImportDiagnostic[]
): {
  notes: MidiNote[];
  maxTick: number;
  nextDivisions: number;
  nextTimeSignature: { numerator: number; denominator: number };
} {
  const notes: MidiNote[] = [];
  const localPositions = new Map<string, number>();
  const lastStartTicks = new Map<string, number>();
  const lastDurationTicks = new Map<string, number>();
  let cursorTicks = 0;
  let maxTick = measureState.startTicks;
  let currentDivisions = measureState.divisions;
  let currentTimeSignature = measureState.timeSignature;
  let sawContent = false;

  for (const child of Array.from(measureElement.children)) {
    switch (child.nodeName) {
      case "attributes": {
        const divisions = textToInt(findDirectChildText(child, "divisions"));
        if (divisions && divisions > 0) {
          currentDivisions = divisions;
        }

        const timeSignature = parseTimeSignature(child);
        if (timeSignature) {
          currentTimeSignature = timeSignature;
          if (!sawContent && cursorTicks === 0) {
            measureState.timeSignature = timeSignature;
            measureState.lengthTicks = ticksPerMeasure(ppq, timeSignature.numerator, timeSignature.denominator);
          }
          timeSignatures.push({
            ticks: measureState.startTicks + cursorTicks,
            numerator: timeSignature.numerator,
            denominator: timeSignature.denominator
          });
        }

        const keySignature = parseKeySignature(child);
        if (keySignature) {
          keySignatures.push({
            ticks: measureState.startTicks + cursorTicks,
            key: keySignature.key,
            scale: keySignature.scale
          });
        }
        break;
      }
      case "direction": {
        const soundTempo = parseDirectionTempo(child);
        if (soundTempo !== null) {
          tempos.push({
            ticks: measureState.startTicks + cursorTicks,
            bpm: soundTempo
          });
        }
        break;
      }
      case "backup": {
        const duration = durationToTicks(textToInt(findDirectChildText(child, "duration")), currentDivisions, ppq);
        cursorTicks = Math.max(0, cursorTicks - duration);
        sawContent = true;
        break;
      }
      case "forward": {
        const duration = durationToTicks(textToInt(findDirectChildText(child, "duration")), currentDivisions, ppq);
        cursorTicks += duration;
        maxTick = Math.max(maxTick, measureState.startTicks + cursorTicks);
        sawContent = true;
        break;
      }
      case "note": {
        const parsed = parseNote(
          child,
          partIndex,
          partInfo,
          measureIndex,
          measureState.startTicks,
          cursorTicks,
          currentDivisions,
          ppq,
          lastStartTicks,
          lastDurationTicks,
          diagnostics
        );

        if (parsed) {
          if (parsed.note) {
            notes.push(parsed.note);
            maxTick = Math.max(maxTick, parsed.note.endTicks);
            lastStartTicks.set(parsed.voiceStaffKey, parsed.note.startTicks);
            lastDurationTicks.set(parsed.voiceStaffKey, parsed.durationTicks);
          }
          if (!parsed.isChord) {
            cursorTicks += parsed.durationTicks;
            localPositions.set(parsed.voiceStaffKey, cursorTicks);
          }
          sawContent = true;
        }
        break;
      }
      default:
        break;
    }
  }

  if (!sawContent) {
    maxTick = Math.max(maxTick, measureState.startTicks + measureState.lengthTicks);
  }
  maxTick = Math.max(maxTick, measureState.startTicks + measureState.lengthTicks);

  return {
    notes,
    maxTick,
    nextDivisions: currentDivisions,
    nextTimeSignature: currentTimeSignature
  };
}

type ParsedNoteResult = {
  note: MidiNote | null;
  durationTicks: number;
  isChord: boolean;
  voiceStaffKey: string;
};

function parseNote(
  noteElement: Element,
  partIndex: number,
  partInfo: PartInfo,
  measureIndex: number,
  measureStartTicks: number,
  cursorTicks: number,
  currentDivisions: number,
  ppq: number,
  lastStartTicks: Map<string, number>,
  lastDurationTicks: Map<string, number>,
  diagnostics: MusicXmlImportDiagnostic[]
): ParsedNoteResult | null {
  if (hasDirectChild(noteElement, "grace")) {
    diagnostics.push({
      severity: "info",
      code: "GRACE_NOTE_SKIPPED",
      message: "已跳过 MusicXML grace note。"
    });
    return null;
  }

  const staff = Math.max(1, textToInt(findDirectChildText(noteElement, "staff")) || 1);
  const voice = Math.max(1, textToInt(findDirectChildText(noteElement, "voice")) || 1);
  const voiceStaffKey = `${voice}:${staff}`;
  const isChord = hasDirectChild(noteElement, "chord");
  const isRest = hasDirectChild(noteElement, "rest");
  const durationText = findDirectChildText(noteElement, "duration");
  const timeModification = parseTimeModification(noteElement);
  let durationTicks = durationToTicks(textToInt(durationText), currentDivisions, ppq);

  if (!durationTicks) {
    const typeDuration = durationFromType(noteElement, timeModification, ppq);
    durationTicks = typeDuration || lastDurationTicks.get(voiceStaffKey) || 0;
  }

  if (!durationTicks) {
    diagnostics.push({
      severity: "warning",
      code: "NOTE_DURATION_MISSING",
      message: "MusicXML note 缺少可用时值，已跳过。",
      partId: partInfo.id,
      measureIndex,
      tick: measureStartTicks + cursorTicks
    });
    return null;
  }

  if (isRest) {
    return {
      note: null,
      durationTicks,
      isChord,
      voiceStaffKey
    };
  }

  const startTicks = isChord
    ? lastStartTicks.get(voiceStaffKey) ?? measureStartTicks + cursorTicks
    : measureStartTicks + cursorTicks;
  const pitch = parsePitch(noteElement);
  if (!pitch) {
    return null;
  }

  const velocity = parseVelocity(noteElement);
  const tieStart = hasTie(noteElement, "start");
  const tieStop = hasTie(noteElement, "stop");

  return {
    note: {
      id: `${partInfo.id}-${measureIndex}-${startTicks}-${pitch.midi}-${notesHash(noteElement)}`,
      midi: pitch.midi,
      name: pitch.name,
      startMs: 0,
      durationMs: 0,
      endMs: 0,
      velocity,
      trackIndex: partIndex,
      trackName: partInfo.name,
      startTicks,
      durationTicks,
      endTicks: startTicks + durationTicks,
      channel: partInfo.channel ?? 0,
      program: partInfo.program,
      instrumentName: partInfo.instrumentName,
      isDrum: partInfo.isDrum,
      tieStart,
      tieStop
    },
    durationTicks,
    isChord,
    voiceStaffKey
  };
}

function parsePitch(noteElement: Element): { midi: number; name: string } | null {
  const pitchElement = findDirectChild(noteElement, "pitch");
  if (pitchElement) {
    const step = findDirectChildText(pitchElement, "step");
    const octave = textToInt(findDirectChildText(pitchElement, "octave"));
    if (!step || octave === null) {
      return null;
    }
    const alter = textToNumber(findDirectChildText(pitchElement, "alter")) ?? 0;
    const midi = pitchToMidi(step, alter, octave);
    return { midi, name: `${step}${alterToText(alter)}${octave}` };
  }

  const unpitched = findDirectChild(noteElement, "unpitched");
  if (unpitched) {
    const step = findDirectChildText(unpitched, "display-step");
    const octave = textToInt(findDirectChildText(unpitched, "display-octave"));
    if (!step || octave === null) {
      return null;
    }
    const midi = pitchToMidi(step, 0, octave);
    return { midi, name: `${step}${octave}` };
  }

  return null;
}

function parseVelocity(noteElement: Element): number {
  const velocity = textToInt(findDirectChildText(noteElement, "velocity"));
  if (velocity && velocity > 0) {
    return Math.max(1, Math.min(127, velocity));
  }
  return 80;
}

function parseTimeModification(noteElement: Element): { actualNotes: number; normalNotes: number } | undefined {
  const timeModification = findDirectChild(noteElement, "time-modification");
  if (!timeModification) {
    return undefined;
  }

  const actualNotes = textToInt(findDirectChildText(timeModification, "actual-notes")) ?? 0;
  const normalNotes = textToInt(findDirectChildText(timeModification, "normal-notes")) ?? 0;
  if (actualNotes > 0 && normalNotes > 0) {
    return { actualNotes, normalNotes };
  }
  return undefined;
}

function durationFromType(
  noteElement: Element,
  timeModification: { actualNotes: number; normalNotes: number } | undefined,
  ppq: number
): number {
  const type = findDirectChildText(noteElement, "type");
  if (!type) {
    return 0;
  }

  const baseQuarterUnits = typeToQuarterUnits(type);
  if (!baseQuarterUnits) {
    return 0;
  }

  const dots = Array.from(noteElement.children).filter((child) => child.nodeName === "dot").length;
  let quarterUnits = baseQuarterUnits;
  let dotSpan = baseQuarterUnits;
  for (let index = 0; index < dots; index += 1) {
    dotSpan *= 0.5;
    quarterUnits += dotSpan;
  }

  if (timeModification) {
    quarterUnits *= timeModification.normalNotes / timeModification.actualNotes;
  }

  return Math.max(1, Math.round(quarterUnits * ppq));
}

function parseTimeSignature(attributesElement: Element): { numerator: number; denominator: number } | null {
  const timeElement = findDirectChild(attributesElement, "time");
  if (!timeElement) {
    return null;
  }

  const beats = textToInt(findDirectChildText(timeElement, "beats"));
  const beatType = textToInt(findDirectChildText(timeElement, "beat-type"));
  if (!beats || !beatType) {
    return null;
  }

  return {
    numerator: beats,
    denominator: beatType
  };
}

function parseKeySignature(attributesElement: Element): { key: string; scale: string } | null {
  const keyElement = findDirectChild(attributesElement, "key");
  if (!keyElement) {
    return null;
  }

  const fifths = textToInt(findDirectChildText(keyElement, "fifths"));
  if (fifths === null) {
    return null;
  }

  const mode = (findDirectChildText(keyElement, "mode") ?? "major").trim().toLowerCase();
  return {
    key: keyFromFifths(fifths, mode),
    scale: mode.startsWith("minor") ? "minor" : "major"
  };
}

function parseDirectionTempo(directionElement: Element): number | null {
  const soundElement = findDirectChild(directionElement, "sound");
  const tempoText = soundElement?.getAttribute("tempo");
  if (tempoText) {
    const bpm = Number(tempoText);
    if (Number.isFinite(bpm) && bpm > 0) {
      return bpm;
    }
  }

  const metronomeElement = findNestedChild(directionElement, "metronome");
  const perMinute = metronomeElement ? textToNumber(findDirectChildText(metronomeElement, "per-minute")) : null;
  if (perMinute && perMinute > 0) {
    return perMinute;
  }

  return null;
}

function computeResolution(root: Element): number {
  const candidates = new Set<number>([DEFAULT_PPQ]);
  for (const divisionsNode of Array.from(root.getElementsByTagName("divisions"))) {
    const value = textToInt(textContent(divisionsNode));
    if (value && value > 0) {
      candidates.add(value);
    }
  }
  for (const beatTypeNode of Array.from(root.getElementsByTagName("beat-type"))) {
    const value = textToInt(textContent(beatTypeNode));
    if (value && value > 0) {
      candidates.add(value);
    }
  }

  return [...candidates].reduce((acc, value) => lcm(acc, value), 1);
}

function parsePartInfos(root: Element): Map<string, PartInfo> {
  const partInfos = new Map<string, PartInfo>();
  const partList = Array.from(root.children).find((child) => child.nodeName === "part-list") as Element | undefined;
  if (!partList) {
    return partInfos;
  }

  for (const scorePart of Array.from(partList.children).filter((child) => child.nodeName === "score-part") as Element[]) {
    const id = scorePart.getAttribute("id") ?? `P${partInfos.size + 1}`;
    const name =
      findDirectChildText(scorePart, "part-name") ||
      findDirectChildText(scorePart, "part-abbreviation") ||
      id;
    const scoreInstrument = Array.from(scorePart.children).find((child) => child.nodeName === "score-instrument") as
      | Element
      | undefined;
    const midiInstrument = Array.from(scorePart.children).find((child) => child.nodeName === "midi-instrument") as
      | Element
      | undefined;
    const instrumentName =
      findDirectChildText(scoreInstrument ?? scorePart, "instrument-name") ||
      findDirectChildText(midiInstrument ?? scorePart, "midi-name") ||
      name;
    const channelText = midiInstrument ? findDirectChildText(midiInstrument, "midi-channel") : null;
    const programText = midiInstrument ? findDirectChildText(midiInstrument, "midi-program") : null;
    const channel = channelText ? clampChannel(textToInt(channelText)) : null;
    const program = clampProgram(textToInt(programText) ?? 1);
    const isDrum =
      (channelText !== null && clampChannel(textToInt(channelText)) === 9) ||
      /drum|percussion/i.test(`${name} ${instrumentName}`);

    partInfos.set(id, {
      id,
      name,
      instrumentName,
      channel,
      program,
      isDrum
    });
  }

  return partInfos;
}

function createFallbackPartInfo(partId: string, partIndex: number): PartInfo {
  return {
    id: partId,
    name: `Part ${partIndex + 1}`,
    instrumentName: `Part ${partIndex + 1}`,
    channel: null,
    program: 1,
    isDrum: false
  };
}

function normalizeTempos(tempos: PendingTempo[], durationTicks: number): ParsedMidiMeta["tempos"] {
  const sorted = [...tempos].filter((tempo) => tempo.bpm > 0).sort((a, b) => a.ticks - b.ticks);
  if (!sorted.length || sorted[0].ticks !== 0) {
    sorted.unshift({ ticks: 0, bpm: DEFAULT_BPM });
  }
  return dedupeByTick(sorted).map((tempo) => ({
    ticks: Math.max(0, Math.min(durationTicks, Math.round(tempo.ticks))),
    bpm: tempo.bpm
  }));
}

function normalizeTimeSignatures(
  signatures: PendingTimeSignature[],
  durationTicks: number
): ParsedMidiMeta["timeSignatures"] {
  const sorted = [...signatures]
    .filter((signature) => signature.numerator > 0 && signature.denominator > 0)
    .sort((a, b) => a.ticks - b.ticks);
  if (!sorted.length || sorted[0].ticks !== 0) {
    sorted.unshift({ ticks: 0, ...FALLBACK_TIME_SIGNATURE });
  }
  return dedupeByTick(sorted).map((signature) => ({
    ticks: Math.max(0, Math.min(durationTicks, Math.round(signature.ticks))),
    numerator: signature.numerator,
    denominator: signature.denominator
  }));
}

function normalizeKeySignatures(signatures: PendingKeySignature[]): ParsedMidiMeta["keySignatures"] {
  const sorted = [...signatures].sort((a, b) => a.ticks - b.ticks);
  if (!sorted.length || sorted[0].ticks !== 0) {
    sorted.unshift({ ticks: 0, ...FALLBACK_KEY_SIGNATURE });
  }
  return dedupeByTick(sorted).map((signature) => ({
    ticks: Math.max(0, Math.round(signature.ticks)),
    key: signature.key,
    scale: signature.scale
  }));
}

function dedupeByTick<T extends { ticks: number }>(items: T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    const existingIndex = result.findIndex((candidate) => candidate.ticks === item.ticks);
    if (existingIndex >= 0) {
      result[existingIndex] = item;
    } else {
      result.push(item);
    }
  }
  return result.sort((a, b) => a.ticks - b.ticks);
}

function formatKeyName(signature: { key: string; scale: string }): string {
  return signature.scale === "minor" ? `${signature.key} minor` : signature.key;
}

function ticksToMs(ticks: number, tempos: ParsedMidiMeta["tempos"], ppq: number): number {
  const sorted = [...tempos].sort((a, b) => a.ticks - b.ticks);
  let currentBpm = sorted[0]?.bpm ?? DEFAULT_BPM;
  let lastTick = 0;
  let ms = 0;

  for (const tempo of sorted) {
    if (tempo.ticks > ticks) {
      break;
    }
    ms += ticksToMsRange(lastTick, tempo.ticks, currentBpm, ppq);
    currentBpm = tempo.bpm;
    lastTick = tempo.ticks;
  }

  ms += ticksToMsRange(lastTick, ticks, currentBpm, ppq);
  return ms;
}

function ticksToMsRange(startTick: number, endTick: number, bpm: number, ppq: number): number {
  if (endTick <= startTick) {
    return 0;
  }
  return ((endTick - startTick) * 60000) / (Math.max(1, bpm) * Math.max(1, ppq));
}

function durationToTicks(durationDivisions: number | null, currentDivisions: number, ppq: number): number {
  if (!durationDivisions || durationDivisions <= 0) {
    return 0;
  }
  const scale = currentDivisions > 0 ? ppq / currentDivisions : ppq;
  return Math.max(1, Math.round(durationDivisions * scale));
}

function pitchToMidi(step: string, alter: number, octave: number): number {
  const stepValue: Record<string, number> = {
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
    A: 9,
    B: 11
  };
  return (octave + 1) * 12 + (stepValue[step.toUpperCase()] ?? 0) + alter;
}

function alterToText(alter: number): string {
  if (alter === 1) {
    return "#";
  }
  if (alter === -1) {
    return "b";
  }
  if (alter === 0) {
    return "";
  }
  return alter > 0 ? `+${alter}` : `${alter}`;
}

function typeToQuarterUnits(type: string): number {
  switch (type.trim().toLowerCase()) {
    case "1024th":
      return 1 / 256;
    case "512th":
      return 1 / 128;
    case "256th":
      return 1 / 64;
    case "128th":
      return 1 / 32;
    case "64th":
      return 1 / 16;
    case "32nd":
      return 1 / 8;
    case "16th":
      return 1 / 4;
    case "eighth":
      return 1 / 2;
    case "quarter":
      return 1;
    case "half":
      return 2;
    case "whole":
      return 4;
    case "breve":
      return 8;
    case "long":
      return 16;
    case "maxima":
      return 32;
    default:
      return 0;
  }
}

function keyFromFifths(fifths: number, mode: string): string {
  const majorKeys = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
  const index = Math.max(0, Math.min(14, fifths + 7));
  const majorKey = majorKeys[index] ?? "C";
  if (!mode.startsWith("minor")) {
    return majorKey;
  }

  const relativeMinorMap: Record<string, string> = {
    Cb: "Ab",
    Gb: "Eb",
    Db: "Bb",
    Ab: "F",
    Eb: "C",
    Bb: "G",
    F: "D",
    C: "A",
    G: "E",
    D: "B",
    A: "F#",
    E: "C#",
    B: "G#",
    "F#": "D#",
    "C#": "A#"
  };
  return relativeMinorMap[majorKey] ?? majorKey;
}

function allocateChannel(partIndex: number, isDrum: boolean): number {
  if (isDrum) {
    return 9;
  }
  const channel = partIndex % 15;
  return channel >= 9 ? channel + 1 : channel;
}

function clampChannel(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.max(0, Math.min(15, value - 1));
  return normalized;
}

function clampProgram(value: number): number {
  return Math.max(0, Math.min(127, value - 1));
}

function notesHash(noteElement: Element): number {
  let hash = 0;
  const text = noteElement.textContent ?? "";
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

function hasTie(noteElement: Element, type: "start" | "stop"): boolean {
  for (const tie of Array.from(noteElement.children).filter((child) => child.nodeName === "tie")) {
    if (tie.getAttribute("type") === type) {
      return true;
    }
  }

  const notations = findDirectChild(noteElement, "notations");
  if (!notations) {
    return false;
  }

  for (const tied of Array.from(notations.children).filter((child) => child.nodeName === "tied")) {
    if (tied.getAttribute("type") === type) {
      return true;
    }
  }

  return false;
}

function parseXmlDocument(xmlText: string, fileName: string): Document {
  const document = new XmlDomParser().parseFromString(xmlText, "application/xml") as unknown as Document;
  const parserError = document.getElementsByTagName("parsererror")[0];
  if (parserError) {
    throw new Error(`无法解析 MusicXML：${stripTags(parserError.textContent ?? fileName)}`);
  }
  return document;
}

function stripTags(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.(xml|musicxml|mxl|mid|midi)$/i, "");
}

function findScoreTitle(root: Element): string {
  const workTitle = findNestedChildText(root, "work-title");
  if (workTitle) {
    return workTitle;
  }
  const movementTitle = findNestedChildText(root, "movement-title");
  if (movementTitle) {
    return movementTitle;
  }
  const partName = findNestedChildText(root, "part-name");
  return partName || "";
}

function findNestedChildText(root: Element, tagName: string): string {
  for (const child of Array.from(root.getElementsByTagName(tagName))) {
    const text = textContent(child).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function findDirectChild(parent: Element, tagName: string): Element | null {
  return Array.from(parent.children).find((child) => child.nodeName === tagName) ?? null;
}

function findDirectChildText(parent: Element, tagName: string): string {
  return textContent(findDirectChild(parent, tagName));
}

function findFirstText(parent: Element, tagName: string, attributeName: string): string {
  const child = Array.from(parent.getElementsByTagName(tagName))[0] as Element | undefined;
  return child?.getAttribute(attributeName) ?? "";
}

function findNestedChild(parent: Element, tagName: string): Element | null {
  const child = Array.from(parent.getElementsByTagName(tagName))[0] as Element | undefined;
  return child ?? null;
}

function hasDirectChild(parent: Element, tagName: string): boolean {
  return Array.from(parent.children).some((child) => child.nodeName === tagName);
}

function textContent(node: Element | null): string {
  return node?.textContent?.trim() ?? "";
}

function textToInt(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function textToNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseFloat(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function looksLikeZip(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer.slice(0, 4));
  return bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) {
    return "";
  }
  return file.async("text");
}

function ticksPerMeasure(ppq: number, numerator: number, denominator: number): number {
  return Math.max(1, Math.round((ppq * 4 * numerator) / Math.max(1, denominator)));
}

function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }
  return x || 1;
}
