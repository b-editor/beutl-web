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

// What the background of a generated picture may be. "auto" leaves it to the
// model and is the one shape every model takes, because it means the field is
// never sent; the other two are asked for by name and models differ over which
// they publish (GPT Image-1 cuts a background out, GPT Image-2 fills one in).
// "transparent" only produces a usable result in a format with an alpha
// channel, which is why generated output stays PNG.
export const AI_IMAGE_BACKGROUNDS = ["auto", "opaque", "transparent"] as const;
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

// 同じ理由でここに置く上限たち。Server Action の本文上限はアプリ全体で 1 つしか
// なく、パッケージのアップロードに合わせた大きさになっている——AI の画面が受け
// 取れる量はそれよりずっと小さいので、届く前に断るには画面の側でも同じ数を
// 知っている必要がある。Re-exported from ai/upload-limits.ts for the server side.
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_AI_IMAGE_UPLOAD_BYTES = 20 * 1024 * 1024;
// 参照画像は全部そろえて base64 データ URL にし、JSON でもう一度複製される。
// 1 枚あたりの上限を枚数分そのまま許すと、生バイトだけで 80MiB、base64 で
// 107MiB になり Worker のメモリ予算を超える。1 枚のときと同じ総量までに抑える。
export const MAX_AI_IMAGE_REFERENCES_TOTAL_BYTES = MAX_AI_IMAGE_UPLOAD_BYTES;
// Two frame images are embedded as base64 data URLs and then copied again by
// JSON serialization. Keep this substantially below the ordinary image-edit
// limit so a two-frame request stays within the Worker's memory budget.
export const MAX_AI_VIDEO_FRAME_UPLOAD_BYTES = 5 * 1024 * 1024;
// A canonical maximum-size translation payload can contain 200 64-character
// IDs plus 20,000 multi-byte UTF-8 text characters.
export const MAX_AI_TRANSLATION_JSON_REQUEST_BYTES = 128 * 1024;
// 保存する結果が、エディタで読める大きさに収まっていること。エディタの読み手
// (AiCaptionHistoryResultParser) はこの数を超えたものを丸ごと拒む——超えた
// まま保存すると、支払い済みなのに取りに行けない結果ができる。
export const MAX_AI_RESULT_SEGMENTS = 10_000;
export const MAX_AI_RESULT_TEXT_LENGTH = 100_000;
// 保存する文字の結果そのものの大きさ。エディタの読み手が受け取る上限と同じ。
export const MAX_AI_RESULT_BYTES = 8 * 1024 * 1024;
// ファイル以外に本文へ入るもの——境界と、画面が並べる文章の欄。動画の画面は
// 5 つの欄を持ち、どれも上限まで書けて、UTF-8 では 1 文字が 4 バイトになる。
// 足りないと、送れるはずの依頼が届く前に断られるので、多めに見る。
const AI_SCREEN_FIELDS_BYTES = MULTIPART_OVERHEAD_BYTES + 6 * MAX_AI_PROMPT_LENGTH * 4;
// 切れ端を持ち帰る画面は、次の送信でその前の結果を一緒に送り返す
// (useActionState が前回の state を本文に載せる)。そのぶんを見ておかないと、
// 一度長い文字起こしをしたあと、正しい大きさの音声が届く前に断られる。

/**
 * その画面の依頼が本文に許される大きさ。名前のない画面には null。
 *
 * Server Action の本文上限はアプリ全体で 1 つで、いちばん大きいものに合わせて
 * ある。そのままでは、AI の画面へ有効な 1 ファイルと無関係な詰め物を送るだけで、
 * 断られるより先に本文まるごとを組み立てさせられる。画面ごとの上限がここにあれば、
 * 本文を読む前に断れる。
 *
 * 迷うなら大きいほうへ——小さすぎれば、送れるはずの依頼が送れなくなる。
 */
export function aiScreenUploadLimit(pathname: string): number | null {
  const screen = /\/dashboard\/ai\/([a-z-]+)\/?$/u.exec(pathname)?.[1];
  switch (screen) {
    case "edit":
      return MAX_AI_IMAGE_UPLOAD_BYTES + AI_SCREEN_FIELDS_BYTES;
    case "generate":
      return MAX_AI_IMAGE_REFERENCES_TOTAL_BYTES + AI_SCREEN_FIELDS_BYTES;
    case "transcribe":
      return (
        MAX_AI_TRANSCRIPTION_UPLOAD_BYTES
        + AI_SCREEN_FIELDS_BYTES
        + MAX_AI_RESULT_BYTES
      );
    case "video":
      // 始まりと終わりで 2 枚。
      return 2 * MAX_AI_VIDEO_FRAME_UPLOAD_BYTES + AI_SCREEN_FIELDS_BYTES;
    case "translate":
      return (
        MAX_AI_TRANSLATION_JSON_REQUEST_BYTES
        + AI_SCREEN_FIELDS_BYTES
        + MAX_AI_RESULT_BYTES
      );
    default:
      return null;
  }
}
