// Reading finished subtitles out of a reply that is still arriving.
//
// The model answers a translation with one strict-schema object,
// `{"segments":[{"id":"…","text":"…"}, …]}`, and a streamed reply delivers that
// text a few characters at a time. Waiting for the closing brace before showing
// anything means a file of two hundred subtitles sits blank for a minute, so
// this walks the text as it arrives and hands back each subtitle the moment its
// own object closes.
//
// What it produces is a preview and nothing more. The authoritative result is
// still the whole reply, parsed and checked against the requested IDs once it
// has all arrived, so a reader that misses a segment or reads one wrongly costs
// a progress line rather than a wrong translation.

export type StreamedTranslationSegment = {
  id: string;
  text: string;
};

// A segment object nests nothing, so its own depth is all that has to be
// tracked: depth 1 is the reply object, depth 2 is one subtitle.
const SEGMENT_DEPTH = 2;

export type TranslationSegmentReader = {
  /** The subtitles that became complete within this piece of the reply. */
  push(chunk: string): StreamedTranslationSegment[];
};

export function createTranslationSegmentReader(): TranslationSegmentReader {
  let depth = 0;
  let inString = false;
  let escaped = false;
  // The text of the object currently being read, or null between objects.
  let pending: string | null = null;

  return {
    push(chunk: string): StreamedTranslationSegment[] {
      const completed: StreamedTranslationSegment[] = [];
      for (const character of chunk) {
        if (pending !== null) pending += character;

        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (character === "\\") {
            escaped = true;
          } else if (character === '"') {
            inString = false;
          }
          continue;
        }

        if (character === '"') {
          inString = true;
          continue;
        }
        if (character === "{") {
          depth++;
          if (depth === SEGMENT_DEPTH) pending = "{";
          continue;
        }
        if (character === "}") {
          if (depth === SEGMENT_DEPTH && pending !== null) {
            const segment = parseSegment(pending);
            if (segment) completed.push(segment);
            pending = null;
          }
          depth = Math.max(0, depth - 1);
        }
      }
      return completed;
    },
  };
}

function parseSegment(text: string): StreamedTranslationSegment | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A preview is not worth an exception: the same bytes are parsed properly
    // when the reply is complete, and that is what decides the result.
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("text" in value)
  ) {
    return null;
  }
  const { id, text: translated } = value as Record<string, unknown>;
  return typeof id === "string" && id.length > 0 && typeof translated === "string"
    ? { id, text: translated }
    : null;
}
