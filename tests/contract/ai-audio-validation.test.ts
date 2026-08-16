import { describe, expect, it } from "vitest";
import {
  InvalidTranscriptionResultError,
  validateTranscriptionResult,
} from "../../packages/api/src/ai/audio-validation";

describe("transcription timestamp validation", () => {
  it("accepts monotonic segments and words bounded by the audio duration", () => {
    expect(
      validateTranscriptionResult(
        {
          language: " ja ",
          segments: [
            { start: 0, end: 1.25, text: " First " },
            { start: 1.25, end: 2, text: "Second" },
          ],
          words: [
            { start: 0, end: 0.5, word: " First " },
            { start: 0.5, end: 1.25, word: "line" },
            { start: 1.25, end: 2, word: "Second" },
          ],
        },
        2,
      ),
    ).toEqual({
      language: "ja",
      segments: [
        { start: 0, end: 1.25, text: "First" },
        { start: 1.25, end: 2, text: "Second" },
      ],
      words: [
        { start: 0, end: 0.5, word: "First" },
        { start: 0.5, end: 1.25, word: "line" },
        { start: 1.25, end: 2, word: "Second" },
      ],
    });
  });

  it("allows small provider boundary jitter and clamps duration rounding", () => {
    expect(
      validateTranscriptionResult(
        {
          segments: [
            { start: 0, end: 1.02, text: "First" },
            { start: 1, end: 2.04, text: "Second" },
          ],
          words: [
            { start: 0, end: 1.01, word: "First" },
            { start: 0.98, end: 2.03, word: "Second" },
          ],
        },
        2,
      ),
    ).toEqual({
      segments: [
        { start: 0, end: 1.02, text: "First" },
        { start: 1, end: 2, text: "Second" },
      ],
      words: [
        { start: 0, end: 1.01, word: "First" },
        { start: 0.98, end: 2, word: "Second" },
      ],
    });
  });

  it.each([
    [
      "segment beyond duration",
      { segments: [{ start: 0, end: 2.051, text: "too long" }] },
    ],
    [
      "zero-length segment",
      { segments: [{ start: 1, end: 1, text: "invalid" }] },
    ],
    [
      "overlapping segments",
      {
        segments: [
          { start: 0, end: 1.5, text: "first" },
          { start: 1, end: 2, text: "second" },
        ],
      },
    ],
    [
      "non-monotonic words",
      {
        segments: [{ start: 0, end: 2, text: "valid" }],
        words: [
          { start: 1, end: 1.5, word: "later" },
          { start: 0.5, end: 1, word: "earlier" },
        ],
      },
    ],
    [
      "non-monotonic word ends",
      {
        segments: [{ start: 0, end: 2, text: "valid" }],
        words: [
          { start: 0, end: 1.5, word: "long" },
          { start: 1.45, end: 1.4, word: "backward" },
        ],
      },
    ],
    [
      "word beyond duration",
      {
        segments: [{ start: 0, end: 2, text: "valid" }],
        words: [{ start: 1.5, end: 3, word: "too long" }],
      },
    ],
  ])("rejects %s", (_description, response) => {
    expect(() => validateTranscriptionResult(response, 2))
      .toThrow(InvalidTranscriptionResultError);
  });

  it("rejects an invalid audio duration", () => {
    expect(() =>
      validateTranscriptionResult(
        { segments: [{ start: 0, end: 1, text: "valid" }] },
        Number.NaN,
      )
    ).toThrow("Audio duration is invalid");
  });
});
