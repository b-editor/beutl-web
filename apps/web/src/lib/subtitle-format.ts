// Conversions between the shapes the AI screens deal in: timed cues as they
// come back from transcription, the id/text pairs the translation endpoint
// accepts, and the subtitle files an editor actually wants to download.
//
// Everything here is pure so the forms can convert while the user types and the
// conversions can be pinned by contract tests.

export type SubtitleCue = {
  start: number;
  end: number;
  text: string;
};

export type TranslatableSegment = {
  id: string;
  text: string;
};

// Mirrors the server-side validation in the translate action. Rejecting the
// same input here means a bad paste is reported next to the field instead of
// after a round trip.
const SEGMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
export const MAX_TRANSLATABLE_SEGMENTS = 200;

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

// Shown next to each cue while editing, where hours are noise.
export function formatCueClock(seconds: number): string {
  const total = clampSeconds(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
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
// milliseconds with a comma and WebVTT with a dot; both are accepted.
const TIMESTAMP_LINE =
  /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/u;

function toSeconds(
  hours: string,
  minutes: string,
  seconds: string,
  millis: string,
): number {
  return (
    Number(hours) * 3600 +
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
  let everyEntryIsTimed = true;

  for (const [index, entry] of parsed.entries()) {
    if (entry === null || typeof entry !== "object") {
      return { ok: false, reason: "invalidSegment" };
    }
    const record = entry as { id?: unknown; text?: unknown; start?: unknown; end?: unknown };
    if (typeof record.text !== "string" || record.text.trim().length === 0) {
      return { ok: false, reason: "invalidSegment" };
    }
    const id = typeof record.id === "string" ? record.id : String(index + 1);
    if (!SEGMENT_ID_PATTERN.test(id)) {
      return { ok: false, reason: "invalidSegment" };
    }
    segments.push({ id, text: record.text });
    if (typeof record.start === "number" && typeof record.end === "number") {
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
  if (text.startsWith("[") || text.startsWith("{")) {
    return fromJson(text);
  }
  const cues = parseCueBlocks(text);
  if (cues) {
    return fromCues(cues);
  }
  return fromPlainLines(text);
}

// Re-times a translation with the cues the source came from. Positional because
// the translation endpoint preserves order and returns one entry per input.
export function applyTranslationToCues(
  cues: SubtitleCue[],
  translated: TranslatableSegment[],
): SubtitleCue[] {
  return cues.map((cue, index) => ({
    ...cue,
    text: translated[index]?.text ?? cue.text,
  }));
}
