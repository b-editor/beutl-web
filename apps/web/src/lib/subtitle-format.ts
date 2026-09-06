// Conversions between the shapes the AI screens deal in: timed cues as they
// come back from transcription, the id/text pairs the translation endpoint
// accepts, and the subtitle files an editor actually wants to download.
//
// Everything here is pure so the forms can convert while the user types and the
// conversions can be pinned by contract tests.

import {
  MAX_TRANSLATION_SEGMENTS,
  SAFE_SEGMENT_ID_PATTERN,
} from "@beutl/core";

export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

export type TranslatableSegment = {
  id: string;
  text: string;
};

// Word timings as the transcription returns them. They are what makes a cue
// split land between words instead of in the middle of one.
export type SubtitleWord = {
  start: number;
  end: number;
  word: string;
};

export function readWords(value: unknown): SubtitleWord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as { start?: unknown; end?: unknown; word?: unknown };
    if (
      typeof record.word !== "string" ||
      typeof record.start !== "number" ||
      typeof record.end !== "number"
    ) {
      return [];
    }
    return [{ start: record.start, end: record.end, word: record.word }];
  });
}

// Split `text` near `ratio` of its length, preferring a space so a Latin word
// is not cut in half. Japanese has no spaces, so the proportional position is
// the answer there and the search simply finds nothing.
function splitTextAt(text: string, ratio: number): [string, string] {
  if (text.length < 2) return [text.trim(), ""];
  // Never 0 or text.length: a break at either end produces an empty cue, which
  // is the failure this split exists to avoid.
  const clamp = (index: number) =>
    Math.min(Math.max(index, 1), text.length - 1);
  const target = clamp(Math.round(text.length * ratio));
  const window = Math.max(4, Math.round(text.length * 0.15));
  let best = -1;
  for (let index = 1; index < text.length; index += 1) {
    if (!/\s/u.test(text[index])) continue;
    if (Math.abs(index - target) > window) continue;
    if (best === -1 || Math.abs(index - target) < Math.abs(best - target)) {
      best = index;
    }
  }
  const at = best === -1 ? target : clamp(best);
  const head = text.slice(0, at).trim();
  const tail = text.slice(at).trim();
  // A break that lands inside a run of whitespace can still trim to nothing.
  if (head.length === 0 || tail.length === 0) {
    return [text.slice(0, target).trim(), text.slice(target).trim()];
  }
  return [head, tail];
}

// Cut one cue into two at a word boundary: the words are what say where a
// sentence can actually be broken, and a split by duration alone lands
// mid-word or leaves one half empty.
export function splitCueAtWord(
  cue: SubtitleCue,
  words: SubtitleWord[],
): [SubtitleCue, SubtitleCue] {
  const duration = Math.max(cue.end - cue.start, 0);
  const midpoint = cue.start + duration / 2;
  const inside = words.filter(
    (word) => word.start > cue.start && word.start < cue.end,
  );
  const boundary =
    inside.length > 0
      ? inside.reduce((best, word) =>
          Math.abs(word.start - midpoint) < Math.abs(best.start - midpoint)
            ? word
            : best,
        ).start
      : midpoint;
  const ratio = duration > 0 ? (boundary - cue.start) / duration : 0.5;
  const [head, tail] = splitTextAt(cue.text, ratio);
  return [
    { start: cue.start, end: boundary, text: head },
    { start: boundary, end: cue.end, text: tail },
  ];
}

// The same rules the translate action enforces, so a bad paste is reported next
// to the field instead of after a round trip. Imported rather than restated:
// two copies of a limit that no request ever compares would drift apart with
// nothing to notice.
const SEGMENT_ID_PATTERN = SAFE_SEGMENT_ID_PATTERN;
export const MAX_TRANSLATABLE_SEGMENTS = MAX_TRANSLATION_SEGMENTS;

// Cues as they arrive from an action result or a stored job result. Both are
// `unknown` at the boundary — one crossed a Server Action, the other came back
// from object storage — so the shape is checked rather than asserted.
export function readCues(value: unknown): SubtitleCue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as { start?: unknown; end?: unknown; text?: unknown };
    if (typeof record.text !== "string") return [];
    return [
      {
        start: typeof record.start === "number" ? record.start : 0,
        end: typeof record.end === "number" ? record.end : 0,
        text: record.text,
      },
    ];
  });
}

// A stored translation keeps each segment's original timing under `context`
// when the caller supplied it, which is what lets a finished translation be
// recovered as a subtitle file rather than a list of strings. Segments without
// it can only be recovered as text.
export function readTranslatedCues(value: unknown): SubtitleCue[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const cues: SubtitleCue[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object") return null;
    const record = entry as { text?: unknown; context?: unknown };
    if (typeof record.text !== "string") return null;
    if (record.context === null || typeof record.context !== "object") {
      return null;
    }
    const context = record.context as { start?: unknown; end?: unknown };
    if (typeof context.start !== "number" || typeof context.end !== "number") {
      return null;
    }
    cues.push({ start: context.start, end: context.end, text: record.text });
  }
  return cues;
}

export const MAX_GLOSSARY_ENTRIES = 100;

// A glossary written the way a person writes one: one "term = translation" per
// line. A series keeps its own names for things, and without this every run
// re-invents them.
export function parseGlossary(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const term = line.slice(0, separator).trim();
    const translation = line.slice(separator + 1).trim();
    if (!term || !translation) continue;
    if (term.length > 100 || translation.length > 200) continue;
    entries[term] = translation;
    if (Object.keys(entries).length >= MAX_GLOSSARY_ENTRIES) break;
  }
  return entries;
}

export type SubtitleSourceFormat = "json" | "srt" | "text";

export type SubtitleParseResult =
  | {
      ok: true;
      format: SubtitleSourceFormat;
      segments: TranslatableSegment[];
      // Present only when the source carried timings. Without them a
      // translation can still be produced, just not re-timed into a cue file.
      cues: SubtitleCue[] | null;
    }
  | {
      ok: false;
      reason: "empty" | "invalidJson" | "invalidSegment" | "tooMany";
    };

function clampSeconds(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatTimestamp(seconds: number, separator: "," | "."): string {
  const total = clampSeconds(seconds);
  const milliseconds = Math.round(total * 1000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1000);
  const millis = milliseconds % 1000;
  return (
    `${String(hours).padStart(2, "0")}:` +
    `${String(minutes).padStart(2, "0")}:` +
    `${String(secs).padStart(2, "0")}${separator}` +
    String(millis).padStart(3, "0")
  );
}

// Shown next to each cue while editing, where hours are noise. Rounded to
// centiseconds before the split, so a value just under a minute carries into
// the minute instead of reading as "60.00".
export function formatCueClock(seconds: number): string {
  const centiseconds = Math.round(clampSeconds(seconds) * 100);
  const minutes = Math.floor(centiseconds / 6000);
  const rest = (centiseconds % 6000) / 100;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, index) => {
      const start = formatTimestamp(cue.start, ",");
      const end = formatTimestamp(Math.max(cue.end, cue.start), ",");
      return `${index + 1}\n${start} --> ${end}\n${cue.text.trim()}\n`;
    })
    .join("\n");
}

export function toVtt(cues: SubtitleCue[]): string {
  const body = cues
    .map((cue, index) => {
      const start = formatTimestamp(cue.start, ".");
      const end = formatTimestamp(Math.max(cue.end, cue.start), ".");
      return `${index + 1}\n${start} --> ${end}\n${cue.text.trim()}\n`;
    })
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

export function toPlainText(cues: SubtitleCue[]): string {
  return cues
    .map((cue) => cue.text.trim())
    .filter((text) => text.length > 0)
    .join("\n");
}

// The wire format the translate action expects.
export function toSegmentsJson(segments: TranslatableSegment[]): string {
  return JSON.stringify(segments);
}

// Groups, in order: start h/m/s/ms then end h/m/s/ms. SRT separates the
// milliseconds with a comma and WebVTT with a dot; both are accepted. WebVTT
// also allows the hours to be omitted under one hour, which is what Whisper's
// own writer emits, so the hour group is optional and absent means zero.
const TIMESTAMP_LINE =
  /^(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{2}):(\d{2})[,.](\d{1,3})/u;

function toSeconds(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  millis: string,
): number {
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(millis.padEnd(3, "0")) / 1000
  );
}

// Both formats separate cues with a blank line, and within one cue everything
// ahead of the timing is a label: the cue number in SRT, the optional cue
// identifier in WebVTT. Reading block by block is what tells a label apart from
// dialogue — a line saying "42" is a cue number before the timing and spoken
// text after it, and WebVTT identifiers are arbitrary words that no pattern
// distinguishes from a line of speech. It also drops the WEBVTT header and any
// NOTE or STYLE block, since those carry no timing.
function parseCueBlocks(text: string): SubtitleCue[] | null {
  const blocks = text.replace(/\r\n?/gu, "\n").split(/\n{2,}/u);
  const cues: SubtitleCue[] = [];
  let sawTimestamp = false;

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let current: SubtitleCue | null = null;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = TIMESTAMP_LINE.exec(line);
      if (match) {
        sawTimestamp = true;
        if (current) cues.push(current);
        current = {
          start: toSeconds(match[1], match[2], match[3], match[4]),
          end: toSeconds(match[5], match[6], match[7], match[8]),
          text: "",
        };
        continue;
      }
      // Ahead of this block's first timing, so it is the label.
      if (!current) continue;
      // A file written without blank lines between cues puts the next cue's
      // label here with nothing to mark the boundary. A number is the only
      // label that can still be recognized, so that is where the line goes.
      if (
        index + 1 < lines.length &&
        /^\d+$/u.test(line) &&
        TIMESTAMP_LINE.test(lines[index + 1])
      ) {
        continue;
      }
      current.text = current.text ? `${current.text}\n${line}` : line;
    }
    if (current) cues.push(current);
  }
  if (!sawTimestamp) return null;

  return cues.filter((cue) => cue.text.trim().length > 0);
}

// A leading bracket alone does not mean JSON: a transcript whose first cue is
// "[Music]" starts the same way. It is treated as JSON when it parses as one,
// or when it opens the way a segment list does — so malformed JSON is still
// reported as malformed rather than translated as literal text.
function looksLikeJsonDocument(text: string): boolean {
  if (text.startsWith("{")) return true;
  if (!text.startsWith("[")) return false;
  if (/^\[\s*["{[]/u.test(text)) return true;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

function fromJson(text: string): SubtitleParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalidJson" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: "invalidSegment" };
  }
  if (parsed.length > MAX_TRANSLATABLE_SEGMENTS) {
    return { ok: false, reason: "tooMany" };
  }

  const segments: TranslatableSegment[] = [];
  const cues: SubtitleCue[] = [];
  // The provider returns one translation per ID, so a repeated one makes the
  // reply impossible to match back. Caught here, it is reported next to the
  // field; caught at the response, it has already been charged for.
  const seenIds = new Set<string>();
  // An entry with no ID of its own is numbered, and that number must not land
  // on one another entry already claims — a document that mixes the two forms
  // would otherwise be rejected for a collision it did not contain.
  const claimedIds = new Set(
    parsed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const id = (entry as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    }),
  );
  let nextNumberedId = 1;
  const takeNumberedId = () => {
    while (
      claimedIds.has(String(nextNumberedId)) ||
      seenIds.has(String(nextNumberedId))
    ) {
      nextNumberedId += 1;
    }
    return String(nextNumberedId++);
  };
  let everyEntryIsTimed = true;

  for (const entry of parsed) {
    if (entry === null || typeof entry !== "object") {
      return { ok: false, reason: "invalidSegment" };
    }
    const record = entry as { id?: unknown; text?: unknown; start?: unknown; end?: unknown };
    if (typeof record.text !== "string" || record.text.trim().length === 0) {
      return { ok: false, reason: "invalidSegment" };
    }
    const id =
      typeof record.id === "string" ? record.id : takeNumberedId();
    if (!SEGMENT_ID_PATTERN.test(id) || seenIds.has(id)) {
      return { ok: false, reason: "invalidSegment" };
    }
    seenIds.add(id);
    segments.push({ id, text: record.text });
    const hasStart = record.start !== undefined;
    const hasEnd = record.end !== undefined;
    if (hasStart !== hasEnd) {
      return { ok: false, reason: "invalidSegment" };
    }
    if (hasStart && hasEnd) {
      if (
        typeof record.start !== "number" ||
        typeof record.end !== "number" ||
        !Number.isFinite(record.start) ||
        !Number.isFinite(record.end) ||
        record.start < 0 ||
        record.end <= record.start
      ) {
        return { ok: false, reason: "invalidSegment" };
      }
      cues.push({ start: record.start, end: record.end, text: record.text });
    } else {
      everyEntryIsTimed = false;
    }
  }

  return {
    ok: true,
    format: "json",
    segments,
    cues: everyEntryIsTimed ? cues : null,
  };
}

function fromCues(cues: SubtitleCue[]): SubtitleParseResult {
  if (cues.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (cues.length > MAX_TRANSLATABLE_SEGMENTS) {
    return { ok: false, reason: "tooMany" };
  }
  return {
    ok: true,
    format: "srt",
    segments: cues.map((cue, index) => ({
      id: String(index + 1),
      text: cue.text,
    })),
    cues,
  };
}

function fromPlainLines(text: string): SubtitleParseResult {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (lines.length > MAX_TRANSLATABLE_SEGMENTS) {
    return { ok: false, reason: "tooMany" };
  }
  return {
    ok: true,
    format: "text",
    segments: lines.map((line, index) => ({ id: String(index + 1), text: line })),
    cues: null,
  };
}

// Accepts whatever the user has at hand — the JSON the endpoint speaks, an
// SRT/VTT file out of an editor, or one line per subtitle — so the field is not
// a JSON-only trap.
export function parseSubtitleSource(input: string): SubtitleParseResult {
  const text = input.trim();
  if (text.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (looksLikeJsonDocument(text)) {
    return fromJson(text);
  }
  const cues = parseCueBlocks(text);
  if (cues) {
    return fromCues(cues);
  }
  return fromPlainLines(text);
}

// Re-times a translation with the cues the source came from, paired on the
// segment ID rather than on position. The result panel is editable: delete one
// line and append another and the two lists line up by count again while every
// entry after the deletion has shifted, so pairing by index writes each
// translation onto its neighbour's timing and produces a subtitle file that
// looks finished and is wrong. Null when any translated segment has no cue to
// sit on, because that file cannot be written honestly.
export function applyTranslationToCues(
  cues: SubtitleCue[],
  segments: TranslatableSegment[],
  translated: TranslatableSegment[],
): SubtitleCue[] | null {
  if (cues.length !== segments.length) return null;
  const cueById = new Map(
    segments.map((segment, index) => [segment.id, cues[index]] as const),
  );
  const retimed: SubtitleCue[] = [];
  for (const entry of translated) {
    const cue = cueById.get(entry.id);
    if (!cue) return null;
    retimed.push({ ...cue, text: entry.text });
  }
  return retimed;
}
