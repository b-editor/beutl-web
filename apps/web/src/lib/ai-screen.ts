// 課金つき AI 画面が「送ってよいか」を決めるための判断。React に触れないので、
// ボタンとキーボード送信が同じ答えを使えるし、そのまま試験できる。

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
]);

export function keepsIdempotencyKey(errorCode: string): boolean {
  return RECOVERABLE_AI_ERROR_CODES.has(errorCode);
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
