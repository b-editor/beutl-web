// What a caption request is allowed to contain, shared by every entry point.
//
// The language code and the segment shape both end up inside the prompt sent to
// the provider and inside AiJob.inputParams, which the desktop app reads back.
// An entry point that validates them differently either lets unchecked text
// through on a billed request or writes a job the history cannot render, so the
// rules live here rather than being restated per route.

export {
  ISO_639_1_LANGUAGE_CODES,
  isIso6391LanguageCode,
  MAX_TRANSLATION_CHARACTERS,
  MAX_TRANSLATION_SEGMENTS,
  SAFE_SEGMENT_ID_PATTERN,
  translationCharacterCount,
} from "@beutl/core";
