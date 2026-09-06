import { describe, expect, it } from "vitest";
import { createTranslationSegmentReader } from "../../packages/api/src/ai/translation-stream";

const REPLY = JSON.stringify({
  segments: [
    { id: "cue-1", text: "こんにちは" },
    { id: "cue-2", text: 'She said "go", then {left}' },
    { id: "cue-3", text: "Line one\nLine two" },
  ],
});

// A reply arrives a few characters at a time, and where the pieces fall is not
// something a reader may depend on: the same subtitles have to come out whether
// the reply arrives whole or one character at a time.
function readAll(reply: string, pieceLength: number) {
  const reader = createTranslationSegmentReader();
  const segments = [];
  for (let index = 0; index < reply.length; index += pieceLength) {
    segments.push(...reader.push(reply.slice(index, index + pieceLength)));
  }
  return segments;
}

describe("reading subtitles out of a reply that is still arriving", () => {
  it("gives back each subtitle as its own object closes", () => {
    const reader = createTranslationSegmentReader();
    const opening = REPLY.indexOf("}") + 1;

    const first = reader.push(REPLY.slice(0, opening));
    const rest = reader.push(REPLY.slice(opening));

    expect(first).toEqual([{ id: "cue-1", text: "こんにちは" }]);
    expect(rest.map((segment) => segment.id)).toEqual(["cue-2", "cue-3"]);
  });

  it("reads the same subtitles however the reply is cut up", () => {
    const whole = readAll(REPLY, REPLY.length);
    for (const pieceLength of [1, 2, 3, 7, 13, 64]) {
      expect(readAll(REPLY, pieceLength)).toEqual(whole);
    }
    expect(whole).toEqual([
      { id: "cue-1", text: "こんにちは" },
      { id: "cue-2", text: 'She said "go", then {left}' },
      { id: "cue-3", text: "Line one\nLine two" },
    ]);
  });

  it("is not fooled by braces and quotes inside a subtitle", () => {
    // A subtitle carrying JSON punctuation must not close its own object early,
    // which would show the user half a line and drop the rest.
    const reply = JSON.stringify({
      segments: [{ id: "cue-1", text: '} {"id": "cue-9", "text": "not real"}' }],
    });

    expect(readAll(reply, 1)).toEqual([
      { id: "cue-1", text: '} {"id": "cue-9", "text": "not real"}' },
    ]);
  });

  it("says nothing about a reply it cannot read", () => {
    // The complete reply is parsed and checked separately; a reader that cannot
    // make sense of a piece costs a progress line, not a translation.
    const reader = createTranslationSegmentReader();

    expect(reader.push('{"segments":[{"id":"cue-1"},')).toEqual([]);
    expect(reader.push('{"id":42,"text":"x"},')).toEqual([]);
    expect(reader.push('{"id":"cue-2","text":"ok"}]}')).toEqual([
      { id: "cue-2", text: "ok" },
    ]);
  });

  it("keeps reading after the reply stops mid-subtitle", () => {
    const reader = createTranslationSegmentReader();

    expect(reader.push('{"segments":[{"id":"cue-1","text":"half')).toEqual([]);
  });
});
