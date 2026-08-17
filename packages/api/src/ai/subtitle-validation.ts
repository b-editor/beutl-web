// What a caption request is allowed to contain, shared by every entry point.
//
// The language code and the segment shape both end up inside the prompt sent to
// the provider and inside AiJob.inputParams, which the desktop app reads back.
// An entry point that validates them differently either lets unchecked text
// through on a billed request or writes a job the history cannot render, so the
// rules live here rather than being restated per route.

const ISO_639_1_LANGUAGE_CODES = new Set(
  [
    "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs",
    "ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff",
    "fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id",
    "ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku",
    "kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my",
    "na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu",
    "rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv",
    "sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo",
    "wa wo xh yi yo za zh zu",
  ].flatMap((group) => group.split(" ")),
);

export function isIso6391LanguageCode(value: unknown): value is string {
  return typeof value === "string" && ISO_639_1_LANGUAGE_CODES.has(value);
}

export const MAX_TRANSLATION_SEGMENTS = 200;
export const MAX_TRANSLATION_CHARACTERS = 20_000;
export const SAFE_SEGMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
