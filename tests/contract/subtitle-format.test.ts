import { describe, expect, it } from "vitest";
import {
  applyTranslationToCues,
  formatCueClock,
  MAX_TRANSLATABLE_SEGMENTS,
  parseSubtitleSource,
  toPlainText,
  toSegmentsJson,
  toSrt,
  toVtt,
} from "../../apps/web/src/lib/subtitle-format";

const CUES = [
  { start: 0, end: 1.5, text: "こんにちは" },
  { start: 1.5, end: 3.25, text: "はじめまして" },
];

describe("subtitle export", () => {
  it("writes SRT with comma-separated milliseconds", () => {
    expect(toSrt(CUES)).toBe(
      "1\n00:00:00,000 --> 00:00:01,500\nこんにちは\n" +
        "\n2\n00:00:01,500 --> 00:00:03,250\nはじめまして\n",
    );
  });

  it("writes WebVTT with a header and dot-separated milliseconds", () => {
    expect(toVtt(CUES)).toBe(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.500\nこんにちは\n" +
        "\n2\n00:00:01.500 --> 00:00:03.250\nはじめまして\n",
    );
  });

  it("carries hours past the minute field", () => {
    expect(toSrt([{ start: 3661.007, end: 3662, text: "x" }])).toContain(
      "01:01:01,007 --> 01:01:02,000",
    );
  });

  // A cue whose end was dragged before its start would otherwise emit a
  // backwards range, which players reject outright.
  it("never emits an end before the start", () => {
    expect(toSrt([{ start: 5, end: 1, text: "x" }])).toContain(
      "00:00:05,000 --> 00:00:05,000",
    );
  });

  it("clamps negative and non-finite times to zero", () => {
    expect(toSrt([{ start: -3, end: Number.NaN, text: "x" }])).toContain(
      "00:00:00,000 --> 00:00:00,000",
    );
  });

  it("drops empty lines from the plain text export", () => {
    expect(toPlainText([...CUES, { start: 4, end: 5, text: "  " }])).toBe(
      "こんにちは\nはじめまして",
    );
  });

  it("formats the editing clock without hours", () => {
    expect(formatCueClock(0)).toBe("00:00.00");
    expect(formatCueClock(65.5)).toBe("01:05.50");
    expect(formatCueClock(-1)).toBe("00:00.00");
  });
});

describe("subtitle source parsing", () => {
  it("reads SRT and numbers the segments from one", () => {
    const result = parseSubtitleSource(
      "1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:01,500 --> 00:00:03,250\nWorld\n",
    );
    expect(result).toEqual({
      ok: true,
      format: "srt",
      segments: [
        { id: "1", text: "Hello" },
        { id: "2", text: "World" },
      ],
      cues: [
        { start: 0, end: 1.5, text: "Hello" },
        { start: 1.5, end: 3.25, text: "World" },
      ],
    });
  });

  it("does not fold the next cue number into the previous cue's text", () => {
    const result = parseSubtitleSource(toSrt(CUES));
    expect(result.ok && result.segments.map((segment) => segment.text)).toEqual([
      "こんにちは",
      "はじめまして",
    ]);
  });

  it("keeps a multi-line cue as one segment", () => {
    const result = parseSubtitleSource(
      "1\n00:00:00,000 --> 00:00:02,000\nfirst line\nsecond line\n",
    );
    expect(result.ok && result.segments).toEqual([
      { id: "1", text: "first line\nsecond line" },
    ]);
  });

  it("reads WebVTT and ignores its header", () => {
    const result = parseSubtitleSource(toVtt(CUES));
    expect(result.ok && result.format).toBe("srt");
    expect(result.ok && result.cues?.length).toBe(2);
  });

  it("drops a WebVTT cue identifier instead of reading it as dialogue", () => {
    // An identifier is any text on the line before the timing, so nothing about
    // the line itself separates it from a line of speech.
    const result = parseSubtitleSource(
      "WEBVTT\n\nintro\n00:00:00.000 --> 00:00:02.000\nこんにちは\n\nouttro\n00:00:02.000 --> 00:00:04.000\nさようなら\n",
    );

    expect(result.ok && result.segments).toEqual([
      { id: "1", text: "こんにちは" },
      { id: "2", text: "さようなら" },
    ]);
  });

  it("keeps a cue whose only line is a number", () => {
    const result = parseSubtitleSource(
      "1\n00:00:00,000 --> 00:00:02,000\n42\n\n2\n00:00:02,000 --> 00:00:04,000\nnext\n",
    );

    expect(result.ok && result.segments.map((segment) => segment.text)).toEqual([
      "42",
      "next",
    ]);
  });

  it("skips WebVTT NOTE blocks", () => {
    const result = parseSubtitleSource(
      "WEBVTT\n\nNOTE recorded in one take\n\n00:00:00.000 --> 00:00:02.000\nこんにちは\n",
    );

    expect(result.ok && result.segments).toEqual([{ id: "1", text: "こんにちは" }]);
  });

  it("still separates cues run together without a blank line", () => {
    const result = parseSubtitleSource(
      "1\n00:00:00,000 --> 00:00:02,000\nこんにちは\n2\n00:00:02,000 --> 00:00:04,000\nはじめまして\n",
    );

    expect(result.ok && result.segments.map((segment) => segment.text)).toEqual([
      "こんにちは",
      "はじめまして",
    ]);
  });

  it("reads one segment per line of plain text", () => {
    const result = parseSubtitleSource("one\n\ntwo\n");
    expect(result).toEqual({
      ok: true,
      format: "text",
      segments: [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
      ],
      cues: null,
    });
  });

  it("keeps the ids a JSON source already carries", () => {
    const result = parseSubtitleSource('[{"id":"cue_a","text":"Hello"}]');
    expect(result.ok && result.segments).toEqual([
      { id: "cue_a", text: "Hello" },
    ]);
  });

  // The transcription result is JSON with timings, so pasting it back must keep
  // them and stay re-timable after translation.
  it("keeps timings from timed JSON", () => {
    const result = parseSubtitleSource(
      '[{"start":0,"end":1,"text":"Hello"},{"start":1,"end":2,"text":"World"}]',
    );
    expect(result.ok && result.cues).toEqual([
      { start: 0, end: 1, text: "Hello" },
      { start: 1, end: 2, text: "World" },
    ]);
  });

  it("reports no timings when only some JSON entries are timed", () => {
    const result = parseSubtitleSource(
      '[{"start":0,"end":1,"text":"Hello"},{"text":"World"}]',
    );
    expect(result.ok && result.cues).toBeNull();
  });

  it("rejects an id the endpoint would refuse", () => {
    expect(parseSubtitleSource('[{"id":"_a","text":"Hello"}]')).toEqual({
      ok: false,
      reason: "invalidSegment",
    });
  });

  it("rejects malformed JSON", () => {
    expect(parseSubtitleSource("[{")).toEqual({
      ok: false,
      reason: "invalidJson",
    });
  });

  it("rejects an empty source", () => {
    expect(parseSubtitleSource("   \n ")).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("rejects more segments than the endpoint accepts", () => {
    const lines = Array.from(
      { length: MAX_TRANSLATABLE_SEGMENTS + 1 },
      (_, index) => `line ${index}`,
    ).join("\n");
    expect(parseSubtitleSource(lines)).toEqual({
      ok: false,
      reason: "tooMany",
    });
  });

  it("round-trips through the wire format the action expects", () => {
    const parsed = parseSubtitleSource(toSrt(CUES));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.parse(toSegmentsJson(parsed.segments))).toEqual([
      { id: "1", text: "こんにちは" },
      { id: "2", text: "はじめまして" },
    ]);
  });
});

describe("re-timing a translation", () => {
  it("keeps the source timings and takes the translated text", () => {
    expect(
      applyTranslationToCues(CUES, [
        { id: "1", text: "Hello" },
        { id: "2", text: "Nice to meet you" },
      ]),
    ).toEqual([
      { start: 0, end: 1.5, text: "Hello" },
      { start: 1.5, end: 3.25, text: "Nice to meet you" },
    ]);
  });

  it("leaves a cue untouched when the translation is short", () => {
    expect(applyTranslationToCues(CUES, [{ id: "1", text: "Hello" }])).toEqual([
      { start: 0, end: 1.5, text: "Hello" },
      { start: 1.5, end: 3.25, text: "はじめまして" },
    ]);
  });
});
