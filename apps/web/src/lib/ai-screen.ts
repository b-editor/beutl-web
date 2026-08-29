// 課金つき AI 画面が「送ってよいか」を決めるための判断。React に触れないので、
// ボタンとキーボード送信が同じ答えを使えるし、そのまま試験できる。

import {
  AI_TEXT_RESULT_RETENTION_MILLISECONDS,
  MAX_MODEL_ID_LENGTH,
} from "@beutl/core";

// The field name the AI server actions read the idempotency key from. The v3
// API takes the same value in an Idempotency-Key header; a Server Action has no
// header the caller controls, so it travels as a form field.
export const IDEMPOTENCY_KEY_FIELD = "idempotencyKey";

// What the server decided about this user's plan and balance. `availability` is
// keyed by operation and already accounts for the monthly allowance, purchased
// credits and the configured unit price, so the client never has to know what
// an operation costs.
export type AiAccess = {
  canUseAi: boolean;
  availability: Record<string, boolean>;
  // The models each operation offers, in the order they should be shown. No
  // price reaches the client: `costTier` orders them against each other and
  // `available` is the server's answer to whether this account can pay for one.
  models: Record<string, AiScreenModel[]>;
};

export type AiScreenModel = {
  id: string;
  displayName: string;
  costTier: "low" | "medium" | "high" | null;
  available: boolean;
};

export type AiBalance = {
  usedPercent: number;
  remainingPercent: number;
  isExhausted: boolean;
  additionalCredits: number;
  hasAdditionalCreditDebt: boolean;
  // The end of the current billing period, when the monthly allowance resets —
  // or, when `endsAtPeriodEnd` is true, when the plan stops instead.
  periodEnd: string | null;
  endsAtPeriodEnd: boolean;
};

// その名前で問い合わせ直せば結果が戻る失敗。どれも決着ではないので、次の送信は
// 同じリクエストとして扱う——名前を捨てると新規課金になる。
const RECOVERABLE_AI_ERROR_CODES: ReadonlySet<string> = new Set([
  // 応答が途中で切れた。走り切って課金されている可能性がある。
  "aiRequestInterrupted",
  // 最初の実行がまだ走っている。
  "aiRequestInProgress",
  // 支払い済みの結果を今は読み出せなかった。
  "aiResultUnavailable",
  // その名前は別の依頼のもの。中身を元に戻せば、その名前で結果を取り戻せる
  // ——ここで名前を捨てると、戻しても届かなくなる。
  "aiRequestChanged",
]);

export function keepsIdempotencyKey(errorCode: string): boolean {
  return RECOVERABLE_AI_ERROR_CODES.has(errorCode);
}

/** Build a failed AI response while preserving retry identity when recovery is possible. */
export function aiFailureResult(
  errorCode: string,
  t: (key: string) => string,
): {
  success: false;
  message: string;
  keepIdempotencyKey?: boolean;
} {
  return {
    success: false,
    message: t(`api-errors:${errorCode}`),
    ...(keepsIdempotencyKey(errorCode)
      ? { keepIdempotencyKey: true }
      : {}),
  };
}

/**
 * Whether the screen should refuse to send.
 *
 * A run holding its name may be answered by the job that name already made, and
 * the server reaches that job before it asks anything else — before the plan,
 * before the balance, before whether a model is still offered. Refusing here
 * would close the only way back to something already paid for, so a held name
 * overrides every reason the screen has to say no.
 */
export function blocksSubmit(
  blocked: AiBlockReason | null,
  keepsKey: boolean,
): boolean {
  if (blocked === null) return false;
  // 名前を持っているあいだは何も理由にしない。サーバーは、その名前が指す job を
  // 契約の有無やモデルの提供状況より先に返す——残高だけでなく、契約が終わった
  // あとも、モデルが止められたあとも。ここで塞ぐと、支払い済みの結果に手が
  // 届かなくなる。
  return !keepsKey;
}

export type AiBlockReason = "plan" | "balance" | "unavailable";

// A screen is usable when at least one of the operations it offers can be
// started. The image editor offers five, and running out of balance for the
// most expensive one should not hide the others. A screen that starts no
// operation at all — the history — only needs the plan.
export function blockedReason(
  access: AiAccess,
  operations: readonly string[],
  // どの操作にも動かせるモデルが 1 つも無いか。無いなら残高の問題ではないので、
  // 購入を勧めても何も始まらない。
  offersNoModel?: boolean,
): AiBlockReason | null {
  if (!access.canUseAi) return "plan";
  // モデルが無いかどうかが先。残高が足りていても、動かせるモデルが無ければ
  // 送信は必ず拒否されるので、通してはいけない。
  if (offersNoModel) return "unavailable";
  if (
    operations.length === 0 ||
    operations.some((operation) => access.availability[operation])
  ) {
    return null;
  }
  return "balance";
}

/**
 * この画面がいま送信を受け付けるか。
 *
 * ボタンの無効化とキーボード送信は、必ずこの同じ答えを使う。片方だけを見ている
 * と、入力欄で Enter を押したときにボタンが断っているはずの依頼が出ていく。
 */
export function canSubmitAiRequest({
  submitBlocked,
  hasTask,
  taskUnaffordable,
  taskHasNoModel,
  busy,
}: {
  submitBlocked: boolean;
  // 何をするかが選ばれているか。選ばれていない依頼は送りようがない。
  hasTask: boolean;
  // 画面全体ではなく、選ばれている task だけ残高が足りない。
  taskUnaffordable: boolean;
  // 選ばれている task に動かせるモデルが 1 つも無い。
  taskHasNoModel: boolean;
  busy: boolean;
}): boolean {
  return !submitBlocked &&
    hasTask &&
    !taskUnaffordable &&
    !taskHasNoModel &&
    !busy;
}

/**
 * 依頼の中身を 1 本の文字列にする。
 *
 * 名前を持ったまま送り直せるのは、その名前を作った依頼と同じ形のときだけ。
 * 違う形で送ると、サーバーは同じ名前の別の依頼として断り、そこで名前が失われる
 * ——支払い済みの結果へ戻る道が閉じる。利用者が中身を変えたのなら、それは新しい
 * 依頼なので、新しい名前で送る。
 *
 * 渡すのは、サーバーが指紋を取るのと同じもの——組み立てたあと、正規化したあとの
 * 値。ここが細かすぎると、サーバーには同じ依頼が別の名前で届いて二度課金され、
 * 粗すぎると、別の依頼が同じ名前で届いて断られるだけで済む。迷うなら粗いほうへ。
 *
 * ファイルは、名前と{@link fileFingerprint}で読んだ中身で見分ける。更新時刻も、
 * ブラウザが名乗る種類も見ない——更新時刻は同じ中身を作り直すたびに変わり（動画
 * から抜き出した音声がそうなる）、種類はサーバー側で中身から見直されて image/jpg
 * が image/jpeg に、空が audio/mpeg に揃えられる。どちらも、同じものが別の依頼に
 * 化ける。中身を読んでいないファイルは名前と大きさだけで見分けるので、その分だけ
 * 粗い。
 */
export function requestSignature(
  parts: readonly (string | number | boolean | null | undefined | File)[],
): string {
  // 型と長さを添える。区切りだけで繋ぐと、区切り文字を含む値や、境目のずれた
  // 並びが同じ 1 本になり、別の依頼が同じ名前で送られる。
  return parts
    .map((part) => {
      if (part === null || part === undefined) return "n";
      if (part instanceof File) {
        return field("f", `${part.name}\u001e${part.size}`);
      }
      if (typeof part === "string") return field("s", part);
      return field("v", String(part));
    })
    .join("");
}

/** Hash request identity before it crosses the browser persistence boundary. */
export async function digestAiRequestSignature(signature: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(signature),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type PersistedAiRecoveryEntry = {
  digest: string;
  key: string;
  model: string;
  capability: unknown | null;
  updatedAt: number;
};

const MAX_AI_RECOVERY_KEY_LENGTH = 255;
const MAX_AI_RECOVERY_CAPABILITY_BYTES = 16 * 1024;
const MAX_AI_RECOVERY_CAPABILITY_DEPTH = 6;
const MAX_AI_RECOVERY_CAPABILITY_KEYS = 32;
const MAX_AI_RECOVERY_CAPABILITY_ARRAY_LENGTH = 64;
const MAX_AI_RECOVERY_CAPABILITY_STRING_LENGTH = 256;
const MAX_AI_RECOVERY_STORAGE_BYTES = 256 * 1024;

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export const AI_RECOVERY_TTL_MS = AI_TEXT_RESULT_RETENTION_MILLISECONDS;

export function aiRecoveryStorageScope(userId: string, operation: string): string {
  return `beutl.ai.recovery.v1.${encodeURIComponent(userId)}.${operation}`;
}

/** Parse and garbage-collect browser recovery records without exposing raw requests. */
export function restoreAiRecoveryEntries(
  raw: string | null,
  now = Date.now(),
): PersistedAiRecoveryEntry[] {
  try {
    if (
      raw === null ||
      new TextEncoder().encode(raw).byteLength > MAX_AI_RECOVERY_STORAGE_BYTES
    ) {
      return [];
    }
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    const value = parsed as { version?: unknown; entries?: unknown };
    if (value.version !== 1 || !Array.isArray(value.entries)) return [];
    const newestByDigest = new Map<string, PersistedAiRecoveryEntry>();
    for (const candidate of value.entries) {
      if (!isRecoveryEntry(candidate, now)) continue;
      const entry: PersistedAiRecoveryEntry = {
        digest: candidate.digest,
        key: candidate.key,
        model: candidate.model,
        capability: isSafeRecoveryCapability(candidate.capability)
          ? normalizeRecoveryCapability(candidate.capability)
          : null,
        updatedAt: candidate.updatedAt,
      };
      const previous = newestByDigest.get(entry.digest);
      // The later entry wins ties as well. This makes duplicate recovery data
      // deterministic even when a corrupted writer reused a timestamp.
      if (!previous || entry.updatedAt >= previous.updatedAt) {
        newestByDigest.set(entry.digest, entry);
      }
    }
    // Valid active records are unresolved paid identities. Never evict one at
    // restore time merely to satisfy a logical limit; doing so would make a
    // response-loss retry indistinguishable from a new charge. Capacity is
    // enforced by the allocator, which fails closed for a new digest.
    return [...newestByDigest.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

/** Read browser recovery storage without letting privacy failures block the screen. */
export function readAiRecoverySafely(
  read: () => string | null,
  now = Date.now(),
): PersistedAiRecoveryEntry[] {
  try {
    return restoreAiRecoveryEntries(read(), now);
  } catch {
    return [];
  }
}

type RecoveryEntryCandidate = {
  digest: string;
  key: string;
  model: string;
  capability: unknown;
  updatedAt: number;
};

function isRecoveryEntry(value: unknown, now: number): value is RecoveryEntryCandidate {
  if (!isPlainJsonObject(value)) return false;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => PROTOTYPE_POLLUTION_KEYS.has(key))) {
    return false;
  }
  const valid = (
    typeof entry.digest === "string" &&
    /^[0-9a-f]{64}$/u.test(entry.digest) &&
    typeof entry.key === "string" &&
    entry.key.length > 0 &&
    entry.key.length <= MAX_AI_RECOVERY_KEY_LENGTH &&
    /^[\x21-\x7e]+$/u.test(entry.key) &&
    typeof entry.model === "string" &&
    entry.model.length <= MAX_MODEL_ID_LENGTH &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    entry.updatedAt <= now &&
    now - entry.updatedAt <= AI_RECOVERY_TTL_MS
  );
  return valid;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeRecoveryCapability(value: unknown): boolean {
  if (value === null) return true;
  if (!isSafeJsonValue(value)) return false;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_AI_RECOVERY_CAPABILITY_BYTES;
  } catch {
    return false;
  }
}

function isSafeJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") {
    return value.length <= MAX_AI_RECOVERY_CAPABILITY_STRING_LENGTH;
  }
  if (depth >= MAX_AI_RECOVERY_CAPABILITY_DEPTH || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length <= MAX_AI_RECOVERY_CAPABILITY_ARRAY_LENGTH &&
      value.every((item) => isSafeJsonValue(item, depth + 1));
  }
  if (!isPlainJsonObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length <= MAX_AI_RECOVERY_CAPABILITY_KEYS &&
    keys.every((key) =>
      key.length <= MAX_AI_RECOVERY_CAPABILITY_STRING_LENGTH &&
      !PROTOTYPE_POLLUTION_KEYS.has(key) &&
      isSafeJsonValue(value[key], depth + 1)
    );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= minimum && value <= maximum;
}

function normalizeRecoveryCapability(value: unknown): unknown | null {
  if (value === null || !isPlainJsonObject(value)) return null;
  const capability = value as Record<string, unknown>;
  const keys = new Set(Object.keys(capability));
  const imageKeys = new Set(["aspectRatios", "backgrounds", "seed", "maxReferenceImages"]);
  const videoKeys = new Set([
    "resolutions", "durations", "aspectRatios", "generateAudio", "seed",
    "firstFrame", "lastFrame",
  ]);
  const hasVideoField = ["resolutions", "durations", "generateAudio", "firstFrame", "lastFrame"]
    .some((key) => keys.has(key));
  const expected = hasVideoField ? videoKeys : imageKeys;
  if (keys.size !== expected.size || [...keys].some((key) => !expected.has(key))) return null;
  if (hasVideoField) {
    return isStringArray(capability.resolutions) &&
      Array.isArray(capability.durations) &&
      capability.durations.every((duration) => isBoundedInteger(duration, 1, 60)) &&
      isStringArray(capability.aspectRatios) &&
      isBoolean(capability.generateAudio) &&
      isBoolean(capability.seed) &&
      isBoolean(capability.firstFrame) &&
      isBoolean(capability.lastFrame)
      ? value
      : null;
  }
  return isStringArray(capability.aspectRatios) &&
    isStringArray(capability.backgrounds) &&
    isBoolean(capability.seed) &&
    isBoundedInteger(capability.maxReferenceImages, 0, 4)
    ? value
    : null;
}

export function serializeAiRecoveryEntries(
  entries: readonly PersistedAiRecoveryEntry[],
): string {
  // Keep all active entries. This serializer is also used for the legacy
  // aggregate migration, and truncating it could discard an unresolved paid
  // key. New allocations are refused once the active capacity is full.
  const bounded = [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
  return JSON.stringify({ version: 1, entries: bounded });
}

/** Merge recovery records by their stable request digest without dropping keys
 * written by another tab. The newest timestamp wins for a duplicate digest. */
export function mergeAiRecoveryEntries(
  current: readonly PersistedAiRecoveryEntry[],
  incoming: readonly PersistedAiRecoveryEntry[],
): PersistedAiRecoveryEntry[] {
  const byDigest = new Map<string, PersistedAiRecoveryEntry>();
  for (const entry of [...current, ...incoming]) {
    const previous = byDigest.get(entry.digest);
    if (!previous || entry.updatedAt >= previous.updatedAt) {
      byDigest.set(entry.digest, entry);
    }
  }
  return [...byDigest.values()]
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/** Remove exactly one recovery identity from a current snapshot. */
export function removeAiRecoveryEntry(
  entries: readonly PersistedAiRecoveryEntry[],
  digest: string,
): PersistedAiRecoveryEntry[] {
  return entries.filter((entry) => entry.digest !== digest);
}

export function serializeAiRecoveryTombstone(
  key: string,
  settledAt = Date.now(),
): string {
  return JSON.stringify({ version: 1, key, settledAt });
}

export function isAiRecoveryTombstoned(
  serialized: string | null,
  key: string,
): boolean {
  if (!serialized) return false;
  try {
    const value = JSON.parse(serialized) as {
      version?: unknown;
      key?: unknown;
      settledAt?: unknown;
    };
    return value.version === 1
      && value.key === key
      && typeof value.key === "string"
      && value.key.length > 0
      && value.key.length <= MAX_AI_RECOVERY_KEY_LENGTH
      && (value.settledAt === undefined || (
        typeof value.settledAt === "number" && Number.isFinite(value.settledAt)
      ));
  } catch {
    return false;
  }
}

function field(kind: string, value: string): string {
  return `${kind}${value.length}:${value}`;
}

/**
 * 送信ごとの名前の持ち方。
 *
 * 名前は 1 つでは足りない。A を回収している途中で中身を変えた B を送ると、名前は
 * 2 つ同時に未決着になり得る——B の応答で A の名前まで捨てると、支払い済みの A に
 * 戻れなくなる。決着した名前だけを手放し、残りは持ち続ける。
 */
export type AiRequestNames = {
  // 送った依頼ごとの名前。まだ決着していないものだけが入っている。
  held: Readonly<Record<string, string>>;
  // The model that was sent with each held request. It remains available even
  // when the catalog is refreshed and no longer publishes that model.
  heldModels: Readonly<Record<string, string>>;
  // Capability snapshots belong to a request, not to a model. Two unsettled
  // requests may use the same model while the provider catalog changes.
  heldCapabilities: Readonly<Record<string, unknown | null>>;
  // 次に送るものに使う名前。作るのは送るときだけ——書き換えるたびに作っていては、
  // 打鍵のたびに使われない名前が積み上がる。
  next: string;
  // 直前に送った依頼。応答が届いたとき、どの名前の話なのかがこれで分かる。
  sent: string | null;
};

// 名前はまだ無い状態から始める。画面はサーバー側でも一度描かれるので、そこで
// 作ってしまうと、ブラウザで描き直したときの値と食い違う。最初の 1 つはブラウザ
// で、しかも人が触るより前に用意する。
export function newAiRequestNames(): AiRequestNames {
  return { held: {}, heldModels: {}, heldCapabilities: {}, next: "", sent: null };
}

/** まだ名前を用意していなければ、1 つ用意する。 */
export function readyAiRequestNames(
  names: AiRequestNames,
  mint: () => string,
): AiRequestNames {
  return names.next === "" ? { ...names, next: mint() } : names;
}

export function aiRequestNameOf(names: AiRequestNames, request: string): string {
  return names.held[request] ?? names.next;
}

export function holdsAiRequestName(
  names: AiRequestNames,
  request: string,
): boolean {
  return request in names.held;
}

export function holdsAiRequestModel(
  names: AiRequestNames,
  model: string,
): boolean {
  return Object.values(names.heldModels).some((heldModel) => heldModel === model);
}

export function heldAiRequestModels(names: AiRequestNames): string[] {
  return [...new Set(Object.values(names.heldModels))];
}

export function heldAiRequestModelMap(
  names: AiRequestNames,
): Readonly<Record<string, string>> {
  return names.heldModels;
}

export function heldAiRequestCapabilityMap(
  names: AiRequestNames,
): Readonly<Record<string, unknown | null>> {
  return names.heldCapabilities;
}

export function heldAiRequestCapability(
  names: AiRequestNames,
  request: string,
): unknown | null | undefined {
  return names.heldCapabilities[request];
}

/** 送る直前に。この依頼にはこの名前、と決める。 */
export function commitAiRequestName(
  names: AiRequestNames,
  request: string,
  mint: () => string,
  model = "",
  capability: unknown | null = null,
): AiRequestNames {
  if (request in names.held) return { ...names, sent: request };
  return {
    held: { ...names.held, [request]: names.next },
    heldModels: { ...names.heldModels, [request]: model },
    heldCapabilities: { ...names.heldCapabilities, [request]: capability },
    next: mint(),
    sent: request,
  };
}

/** 応答が届いた。決着したのなら、その名前ではもう何も頼めない。 */
export function settleAiRequestName(
  names: AiRequestNames,
  keeps: boolean,
): AiRequestNames {
  if (keeps || names.sent === null || !(names.sent in names.held)) return names;
  const held = { ...names.held };
  delete held[names.sent];
  const heldModels = { ...names.heldModels };
  delete heldModels[names.sent];
  const heldCapabilities = { ...names.heldCapabilities };
  delete heldCapabilities[names.sent];
  return { ...names, held, heldModels, heldCapabilities };
}

export type AiRequestRecoveryEvent =
  | {
      type: "commit";
      request: string;
      model?: string;
      capability?: unknown | null;
    }
  | { type: "settle"; keeps: boolean };

/**
 * The shared recovery state machine used by every paid AI form. Keeping this
 * transition pure makes catalog refreshes and asynchronous responses testable
 * without relying on a particular DOM implementation.
 */
export function reduceAiRequestRecovery(
  names: AiRequestNames,
  event: AiRequestRecoveryEvent,
  mint: () => string = () => "",
): AiRequestNames {
  return event.type === "commit"
    ? commitAiRequestName(
      names,
      event.request,
      mint,
      event.model ?? "",
      event.capability ?? null,
    )
    : settleAiRequestName(names, event.keeps);
}

/**
 * Keep a selected model for an outstanding paid request, otherwise converge to
 * the currently available default. An empty selection is meaningful while a
 * request is held: it represents the server's explicit model-less identity.
 */
export function correctedModelId(
  models: readonly AiScreenModel[],
  chosen: string,
  hasOutstandingModelRequest: boolean,
): string {
  if (hasOutstandingModelRequest) return chosen;
  if (models.some((model) => model.id === chosen)) return chosen;
  return defaultModelIdOf(models);
}

/**
 * A catalog model may start a new request. A removed model may only replay the
 * exact outstanding request that kept it available; while the user restores
 * that request's fields, selecting the model is allowed but submitting is not.
 */
export function canSubmitModelRequest(
  models: readonly AiScreenModel[],
  chosen: string,
  hasOutstandingModelRequest: boolean,
  hasOutstandingRequest: boolean,
): boolean {
  // A model with an unsettled request remains on its first capability
  // snapshot. Do not start a second request under that model until the first
  // one settles; otherwise the UI could not distinguish the two option sets
  // when the catalog changes between renders.
  if (hasOutstandingModelRequest && !hasOutstandingRequest) return false;
  if (models.some((model) => model.id === chosen)) return true;
  return hasOutstandingModelRequest && hasOutstandingRequest;
}

function defaultModelIdOf(models: readonly AiScreenModel[]): string {
  return (models.find((model) => model.available) ?? models[0])?.id ?? "";
}

/**
 * ファイルの中身の見分け。サーバーが指紋にするのと同じもの。
 *
 * 名前と大きさだけでは、中身の違う同名同サイズのファイルが同じ依頼に見える——
 * 片方が走っている間、もう片方は同じ名前で送られて断られ、そちらの依頼を始め
 * られない。読むのは選ばれた時の一度だけで、送るたびではない。
 */
export async function fileFingerprint(
  file: File,
  // 依頼が許されている大きさ。これを超えるものは読まない——送っても断られる
  // ものを丸ごとメモリに載せると、その前にタブのほうが落ちる。
  limit: number,
): Promise<string> {
  if (file.size > limit) return "";
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 一覧から消えたモデルを、まだ回収していない依頼のために残す。
 *
 * 一覧は運営の都合で入れ替わる。選んでいたモデルがそこから消えたとき、既定へ
 * 落とすと依頼の形が変わる——変わった形で送れば、サーバーは同じ名前の別の依頼
 * として断り、支払い済みの結果へ戻る道が閉じる。名指しされたモデルは、一覧に
 * 無くてもサーバーがそのまま受け取るので、その依頼が決着するまでは名乗り続ける。
 *
 * 選べる形で残す。同じ task に未回収の依頼が二つあることもあり、そのときは
 * 選び直せないと、もう一方の名前が指す支払い済みの結果へ戻れない——ここに載る
 * のは未回収の名前を持つモデルだけなので、選んだ先にあるのは新しい課金ではなく
 * 回収のほうだ。
 */
export function keepModelForHeldRequest(
  models: readonly AiScreenModel[],
  chosen: string,
): AiScreenModel[] {
  if (chosen === "" || models.some((model) => model.id === chosen)) {
    return [...models];
  }

  return [
    ...models,
    { id: chosen, displayName: chosen, costTier: null, available: true },
  ];
}

export function modelsWithHeldRequests(
  models: readonly AiScreenModel[],
  heldModels: readonly string[],
): AiScreenModel[] {
  return heldModels.reduce(
    (current, model) => keepModelForHeldRequest(current, model),
    [...models],
  );
}

export type HeldModelCapabilitySnapshots<T> = Record<string, T | null>;

export function mergeHeldRequestCapabilities<T>(
  capabilities: Record<string, T> | undefined,
  snapshots: HeldModelCapabilitySnapshots<T>,
  heldRequests: Readonly<Record<string, string>>,
): Record<string, T> {
  // A model is frozen to its first outstanding request. This keeps every
  // later request on that model deterministic too, so returning to either
  // signature cannot observe a catalog mutation between submissions.
  const merged = { ...(capabilities ?? {}) };
  const byModel = new Map<string, T | null>();
  for (const [request, model] of Object.entries(heldRequests)) {
    const snapshot = snapshots[request];
    if (snapshot === undefined) continue;
    const previous = byModel.get(model);
    if (previous === undefined) {
      byModel.set(model, snapshot);
    }
  }
  for (const [model, snapshot] of byModel) {
    if (snapshot === null) delete merged[model];
    else merged[model] = snapshot;
  }
  return merged;
}

export function mergeHeldModelCapabilities<T>(
  capabilities: Record<string, T> | undefined,
  snapshots: HeldModelCapabilitySnapshots<T>,
  heldModels: readonly string[],
  observedModels: readonly string[] = Object.keys(capabilities ?? {}),
): Record<string, T> {
  const held = new Set(heldModels);
  const observed = new Set([
    ...Object.keys(capabilities ?? {}),
    ...observedModels,
    ...heldModels,
  ]);
  const hasCapability = (model: string) =>
    Object.prototype.hasOwnProperty.call(capabilities ?? {}, model);

  for (const model of observed) {
    // Keep the latest catalog state until a paid request holds this model. The
    // explicit null matters: no capability entry means unrestricted defaults,
    // and a later provider recovery must not rewrite an already-paid signature.
    if (!held.has(model) || !(model in snapshots)) {
      snapshots[model] = hasCapability(model)
        ? capabilities![model]!
        : null;
    }
  }
  for (const model of Object.keys(snapshots)) {
    if (!observed.has(model)) delete snapshots[model];
  }

  const merged = { ...(capabilities ?? {}) };
  for (const model of heldModels) {
    const snapshot = snapshots[model];
    if (snapshot === null) delete merged[model];
    else if (snapshot !== undefined) merged[model] = snapshot;
  }
  return merged;
}

/**
 * 種として送られる値。
 *
 * 欄に書かれたままではなく、サーバーが読み取るのと同じ数にする——"1"、"01"、
 * "1.0" はどれも 1 で、そのまま数えると同じ依頼が三つの名前に割れる。
 */
export function seedValue(text: string): number | null {
  if (text.trim() === "") return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
