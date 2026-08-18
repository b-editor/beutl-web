// What a caption request is allowed to contain, shared by every entry point.
//
// The language code and the segment shape both end up inside the prompt sent to
// the provider and inside AiJob.inputParams, which the desktop app reads back.
// An entry point that validates them differently either lets unchecked text
// through on a billed request or writes a job the history cannot render, so the
// rules live here rather than being restated per route.

// What a translation request costs to send, in characters.
//
// A glossary is caller-supplied text that reaches the provider and is paid for
// there, so it counts against both the request cap and the charge. Counting
// only the segments would let one short line carry thousands of glossary
// characters for the price of a single unit, repeatedly.
export function translationCharacterCount({
  segments,
  style,
}: {
  segments: { text: string }[];
  style?: { glossary?: Record<string, string> } | undefined;
}): number {
  const segmentCharacters = segments.reduce(
    (total, segment) => total + segment.text.length,
    0,
  );
  const glossaryCharacters = Object.entries(style?.glossary ?? {}).reduce(
    (total, [term, translation]) => total + term.length + translation.length,
    0,
  );
  return segmentCharacters + glossaryCharacters;
}

export {
  ISO_639_1_LANGUAGE_CODES,
  isIso6391LanguageCode,
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  SAFE_SEGMENT_ID_PATTERN,
} from "@beutl/core";
