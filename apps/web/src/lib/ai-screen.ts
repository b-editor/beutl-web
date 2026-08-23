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
  // その名前は別の依頼のもの。中身を元に戻せば、その名前で結果を取り戻せる
  // ——ここで名前を捨てると、戻しても届かなくなる。
  "aiRequestChanged",
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
 * ファイルは名前・種類・大きさで見分ける。更新時刻は見ない——同じ中身を作り直す
 * たびに変わるので（動画から抜き出した音声がそうなる）、見ると同じ音声が別の
 * 依頼になってしまう。サーバーは中身のハッシュで見分けるので、こちらが粗い。
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
        return field("f", `${part.name}\u001e${part.type}\u001e${part.size}`);
      }
      if (typeof part === "string") return field("s", part);
      return field("v", String(part));
    })
    .join("");
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
  return { held: {}, next: "", sent: null };
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

/** 送る直前に。この依頼にはこの名前、と決める。 */
export function commitAiRequestName(
  names: AiRequestNames,
  request: string,
  mint: () => string,
): AiRequestNames {
  if (request in names.held) return { ...names, sent: request };
  return {
    held: { ...names.held, [request]: names.next },
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
  return { ...names, held };
}
