// What each AI operation will accept.
//
// GET /api/v3/ai/capabilities serves these lists, so a client outside this
// repository follows a change here without a release of its own, and every
// entry point validates against the same values it publishes.
//
// This lives in @beutl/core, next to AI_PRICING_CATALOG, because a browser
// bundle imports it and @beutl/api pulls in @beutl/db.

// Ratios rather than pixel sizes: the provider's image API is expressed in
// ratios, and the fixed sizes the API used to take were mapped onto them
// anyway. 16:9 and 9:16 are the ones a video editor actually needs.
// 2:3 and 3:2 are here because the legacy sizes map onto them and have been
// requested in production all along; removing them would change what an
// existing client gets back.
export const AI_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "2:3",
  "3:2",
] as const;
export type AiImageAspectRatio = (typeof AI_IMAGE_ASPECT_RATIOS)[number];

// The sizes the v3 image endpoint accepted before ratios existed. Kept so a
// client that still sends one keeps working, and mapped onto the ratio it
// always meant.
export const AI_LEGACY_IMAGE_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
] as const;
export type AiLegacyImageSize = (typeof AI_LEGACY_IMAGE_SIZES)[number];

export const AI_LEGACY_IMAGE_SIZE_ASPECT_RATIOS: Record<
  AiLegacyImageSize,
  AiImageAspectRatio
> = {
  "1024x1024": "1:1",
  "1024x1536": "2:3",
  "1536x1024": "3:2",
};

// "transparent" only produces a usable result in a format with an alpha
// channel, which is why generated output stays PNG.
export const AI_IMAGE_BACKGROUNDS = ["auto", "transparent"] as const;
export type AiImageBackground = (typeof AI_IMAGE_BACKGROUNDS)[number];

// How many pictures a generation may be guided by. Models take between three
// and sixteen; this is the ceiling the price is set against, and every model's
// own limit narrows it further.
//
// It is not free to raise: an image is charged at one price whatever it was
// given, and the cost estimate an administrator prices from assumes this many
// references. Four roughly doubles the assumed provider cost of a generation
// against one.
export const AI_MAX_IMAGE_REFERENCES = 4;

// What a video request may ask for. Each model takes some subset of this, which
// is what the screen offers and what the server checks a request against; these
// are the outer bounds rather than the menu.
//
// A video is charged per second at one rate whatever shape it is, so the price
// an administrator sets has to cover the dearest shape that can be asked for.
// The cost estimate assumes the largest resolution a model offers at 16:9, and
// nothing here may exceed that assumption: 21:9 carries a third more pixels
// than 16:9 and 4K four times as many as 1080p, so both would be billed at a
// price set against something cheaper. They are left out until the price can
// follow the shape.
export const AI_VIDEO_ASPECT_RATIOS = [
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "1:1",
] as const;
export type AiVideoAspectRatio = (typeof AI_VIDEO_ASPECT_RATIOS)[number];

// Ordered from smallest to largest, which is the order the screen offers them
// in and the order that decides which one an estimate assumes. 2K is here for
// MiniMax H3, which renders at nothing else, and prices per second flat.
export const AI_VIDEO_RESOLUTIONS = ["480p", "720p", "1080p", "2K"] as const;
export type AiVideoResolution = (typeof AI_VIDEO_RESOLUTIONS)[number];

// A range rather than a list of three. Veo 3.1 takes 4, 6 or 8 seconds while
// Seedance 2.5 takes any whole second from 4 to 30, and a fixed menu either
// hides most of one model or offers lengths another refuses. Which seconds a
// model actually takes comes from its own capability list; this is only the
// span the server will consider at all.
export const MIN_AI_VIDEO_DURATION_SECONDS = 1;
export const MAX_AI_VIDEO_DURATION_SECONDS = 60;

// Provider-supported deterministic seed. Bounded to a signed 32-bit value so
// the same number survives every JSON encoder between the client and the
// provider.
export const AI_MIN_SEED = 0;
export const AI_MAX_SEED = 2_147_483_647;

export function isAiSeed(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= AI_MIN_SEED &&
    value <= AI_MAX_SEED
  );
}

export function aspectRatioOfLegacyImageSize(
  size: string,
): AiImageAspectRatio | null {
  return (
    AI_LEGACY_IMAGE_SIZE_ASPECT_RATIOS[size as AiLegacyImageSize] ?? null
  );
}

export function isAiVideoDurationSeconds(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MIN_AI_VIDEO_DURATION_SECONDS &&
    value <= MAX_AI_VIDEO_DURATION_SECONDS
  );
}

// Every whole second in range, for a caller that has to present the span as a
// list — a model that publishes no lengths of its own is offered all of them.
export const AI_VIDEO_DURATIONS_SECONDS: readonly number[] = Array.from(
  {
    length:
      MAX_AI_VIDEO_DURATION_SECONDS - MIN_AI_VIDEO_DURATION_SECONDS + 1,
  },
  (_, index) => MIN_AI_VIDEO_DURATION_SECONDS + index,
);

// Which edit tasks need a prompt to mean anything. Published by the
// capabilities endpoint and enforced by every entry point, so a task that
// changes here changes in both places at once.
export const AI_PROMPT_REQUIRED_IMAGE_EDIT_TASKS = [
  "restyle",
  "remove_object",
  "outpaint",
] as const;

export function aiImageEditTaskRequiresPrompt(task: string): boolean {
  return (AI_PROMPT_REQUIRED_IMAGE_EDIT_TASKS as readonly string[]).includes(
    task,
  );
}

// Lives here rather than in @beutl/api so a browser bundle can cap a textarea
// at the same number the server validates against; @beutl/api pulls in
// @beutl/db. Re-exported from ai/upload-limits.ts for the server side.
export const MAX_AI_PROMPT_LENGTH = 4_000;

// The shape of a translation request, here for the same reason: the form that
// parses a pasted subtitle file rejects what the endpoint would reject, and a
// copy of these three in the browser drifts from the copy on the server —
// silently, since neither side ever sees the other's answer.
// Re-exported from ai/subtitle-validation.ts for the server side.
export const MAX_TRANSLATION_SEGMENTS = 200;
export const MAX_TRANSLATION_CHARACTERS = 20_000;
export const SAFE_SEGMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

// Every language a caption request may name, and the only ones it may name.
// Here rather than in @beutl/api so the picker offers exactly what the server
// accepts: a list in the browser that drifts from the one being validated
// against shows a language the request is then refused for.
// Re-exported from ai/subtitle-validation.ts for the server side.
export const ISO_639_1_LANGUAGE_CODES: readonly string[] = [
  "aa ab ae af ak am an ar as av ay az ba be bg bh bi bm bn bo br bs",
  "ca ce ch co cr cs cu cv cy da de dv dz ee el en eo es et eu fa ff",
  "fi fj fo fr fy ga gd gl gn gu gv ha he hi ho hr ht hu hy hz ia id",
  "ie ig ii ik io is it iu ja jv ka kg ki kj kk kl km kn ko kr ks ku",
  "kv kw ky la lb lg li ln lo lt lu lv mg mh mi mk ml mn mr ms mt my",
  "na nb nd ne ng nl nn no nr nv ny oc oj om or os pa pi pl ps pt qu",
  "rm rn ro ru rw sa sc sd se sg si sk sl sm sn so sq sr ss st su sv",
  "sw ta te tg th ti tk tl tn to tr ts tt tw ty ug uk ur uz ve vi vo",
  "wa wo xh yi yo za zh zu",
].flatMap((group) => group.split(" "));

const ISO_639_1_LANGUAGE_CODE_SET = new Set(ISO_639_1_LANGUAGE_CODES);

export function isIso6391LanguageCode(value: unknown): value is string {
  return typeof value === "string" && ISO_639_1_LANGUAGE_CODE_SET.has(value);
}

// Here for the same reason the prompt cap is: the screen that converts a video
// into audio has to know what will fit before it spends a minute decoding one,
// and a copy in the browser would drift from the one being enforced.
// Re-exported from ai/upload-limits.ts for the server side.
export const MAX_AI_TRANSCRIPTION_UPLOAD_BYTES = 25 * 1024 * 1024;
