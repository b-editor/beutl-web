import {
  GitAccountDeletionPhase,
  auditLogActions,
  cancelPendingGitAccountDeletion,
  claimGitAccountDeletion,
  countGitAccountDeletions,
  countGitAccountDeletionsNeedingReview,
  countPurgedGitAccountDeletionsToCheck,
  currentGitRestoreGeneration,
  createAuditLog,
  deleteGitAccountDeletion,
  listPurgedGitAccountDeletions,
  markGitAccountDeletionPurged,
  touchGitAccountDeletion,
  existsUserById,
  findGitAccountByUserId,
  findGitAccountDeletion,
  listExpiredGitAccountDeletionBlocks,
  listPendingGitAccountDeletions,
  markGitAccountDeletionNeedsReview,
  recordGitAccountDeletionAttempt,
  releaseGitAccountDeletionBlock,
  renewGitAccountDeletionLease,
  setGitAccountDeletionTarget,
  startGitAccountDeletion,
} from "@beutl/db";
import { forgejoRequest, forgejoRequestOrNull } from "./client";
import { tokensPath } from "./credentials";
import { ForgejoAccountMismatchError, ForgejoError } from "./errors";
import { assertMappingMatches, noreplyEmailFor } from "./provisioning";
import type { ForgejoAccessToken, ForgejoUser } from "./types";

/**
 * Beutl アカウントの削除に伴う Forgejo 側の後始末。
 *
 * 端末に配った git トークンは Forgejo が直接認証する。git と LFS の通信は Caddy が
 * 素通しするので beutl-web を経由せず、こちらのレコードを消しても push は通り続ける。
 * トークンだけを無効化するフラグは無い (`active: false` も `prohibit_login: true` も
 * git のトークン認証を素通しする。Forgejo 16.0.2 で実測)。
 *
 * 手順は次の通り。
 *
 *   1. beginGitAccountDeletion  — 意思表示を書き、対象を確かめ、トークンを失効させる
 *   2. (呼び出し元) Beutl 側の削除と markGitAccountDeletionReady を同一トランザクションで
 *   3. finishGitAccountDeletion — 身元を確かめ直して purge し、成功したら印を消す
 *
 * 1 の行がある間は資格情報を発行できない。2 を同一トランザクションにするのは、
 * ローカルの削除が失敗したときに「まだ生きている利用者の purge 待ち」を作らないため。
 * 3 は毎回 id とメールを確かめ直す。待っている間に Forgejo が復元され、同じ名前が
 * 別人に渡っていることがある。
 */

/**
 * 印を握っている間の期限。
 *
 * 期限内は他の処理が触らない。切れていれば、握っていた処理は落ちたものとして
 * 引き取られる。長くしすぎると Worker が落ちたあと利用者が待たされ、短くしすぎると
 * 生きている処理が横から引き取られる。トークンの失効は延長しながら進めるので、
 * ここは「1 往復が終わらないほど短くない」長さで足りる。
 */
const DELETION_LEASE_MS = 10 * 60 * 1000;

const leaseDeadline = () => new Date(Date.now() + DELETION_LEASE_MS);

/** トークン一覧の 1 ページあたりの件数。Forgejo の上限は 50。 */
const TOKEN_PAGE_SIZE = 50;

/** 一覧を読む上限ページ数。壊れた応答で無限に回らないための箍。 */
const MAX_TOKEN_PAGES = 40;

/**
 * 同じ利用者の退会処理が既に走っている。
 *
 * 印は利用者ごとに 1 つしか持てないので、後から来た方は相手の印に乗るしかない。
 * 乗ったまま進めると、相手が失敗して印を取り消したときに、後始末できないまま
 * ユーザーだけが消える。乗らずに断る。
 */
export class GitAccountDeletionInProgressError extends Error {
  constructor(readonly userId: string) {
    super(`Another deletion of ${userId} is already in progress`);
    this.name = "GitAccountDeletionInProgressError";
  }
}

export class GitAccountBeingDeletedError extends Error {
  constructor(readonly userId: string) {
    super(`The Git account of ${userId} is being deleted`);
    this.name = "GitAccountBeingDeletedError";
  }
}

/**
 * 退会処理中なら投げる。資格情報の発行の**前と後**に呼ぶ。
 *
 * 後にも呼ぶのは、前だけだと検査から発行までの間に退会が始まった場合に素通りする
 * ため。その 1 本は失効の走査に間に合わず、退会後も生き残る。
 */
export async function assertGitAccountNotBeingDeleted(userId: string) {
  const pending = await findGitAccountDeletion({ userId });
  // PURGED は「消し終えた」墓標で、進行中ではない。beutl-web 側だけを退会前へ
  // 戻すと利用者が復活するが、そのとき墓標を理由に発行を断ると、生きている人が
  // 二度と Git を使えなくなる。止めるのは決着していない 3 つだけ。
  if (pending && pending.phase !== GitAccountDeletionPhase.PURGED) {
    throw new GitAccountBeingDeletedError(userId);
  }
}

/**
 * 対応表が無くても Forgejo 上のユーザーを引き当てる。
 *
 * 対応表と Forgejo は別々にバックアップされるので、beutl-web の DB だけ古い時点に
 * 戻ると「対応表は無いが Forgejo にはユーザーが居る」状態になる。ここで諦めると、
 * 退会したのに端末のトークンが生き続ける。合成メールは userId から決まるので、
 * それで引く。
 */
async function resolveForgejoUser(
  userId: string,
): Promise<{ username: string; id: number } | null> {
  const account = await findGitAccountByUserId({ userId });
  if (account) {
    // 削除は取り返しがつかない。名前・id・メールの 3 点が揃わなければ中止する。
    const actual = await assertMappingMatches(userId, account);
    return { username: account.forgejoUsername, id: actual.id };
  }

  return await findByNoreplyEmail(userId);
}

/**
 * 合成メールから Forgejo 上のユーザーを引く。
 *
 * 合成メールは userId から決まるので、名前が変わっていても引ける。復元で
 * 別の名前になった同じ人を取り逃がさないために要る。
 */
async function findByNoreplyEmail(
  userId: string,
): Promise<{ username: string; id: number } | null> {
  const email = noreplyEmailFor(userId);
  const found = await forgejoRequestOrNull<{ data?: ForgejoUser[] }>(
    "/users/search",
    { searchParams: { q: email, limit: 2 } },
  );
  const matches = (found?.data ?? []).filter((user) => user.email === email);
  if (matches.length !== 1) return null;
  return { username: matches[0].login, id: matches[0].id };
}

/**
 * 控えに名前が無い場合だけ、合成メールから探す。
 *
 * 「探した結果いなかった」と「探せなかった」を混ぜない。混ぜると、Forgejo が
 * 一時的に落ちているだけで人の確認待ちに落ちてしまい、自動では二度と進まない。
 */
async function findUnmappedTarget(
  userId: string,
): Promise<{ found: string | null } | { failed: unknown }> {
  try {
    const target = await resolveForgejoUser(userId);
    return { found: target?.username ?? null };
  } catch (error) {
    return { failed: error };
  }
}

/**
 * 端末に配ったトークンを全て失効させる。@returns 消した本数。
 *
 * `renewLease` は 1 ページ消すごとに呼ぶ。本数が多いと期限を超えることがあり、
 * 超えたまま進むと別の処理に引き取られて 2 つが同じ相手を消しにいく。
 */
async function revokeAllTokens(
  username: string,
  renewLease?: () => Promise<void>,
): Promise<number> {
  let revoked = 0;

  for (let round = 1; round <= MAX_TOKEN_PAGES; round++) {
    // 1 周目にも確かめる。引き取られた後に走り出した処理が、相手のトークンを
    // 消しにいくのを止めるため (相手の失効はやり直せるが、無駄な往復は残る)。
    await renewLease?.();
    // page を指定しないと Forgejo は全件返すが、それは文書化された挙動ではない。
    // 明示的に読む。消しながら読むのでページ番号は進めない。
    const tokens = await forgejoRequest<ForgejoAccessToken[]>(
      tokensPath(username),
      { searchParams: { page: 1, limit: TOKEN_PAGE_SIZE } },
    );
    if (tokens.length === 0) return revoked;

    for (const token of tokens) {
      try {
        await forgejoRequest(tokensPath(username, token.id), {
          method: "DELETE",
          responseType: "none",
        });
        revoked += 1;
      } catch (error) {
        // 既に無いなら目的は達している。それ以外は投げて、退会自体を中止させる。
        if (!(error instanceof ForgejoError && error.isNotFound)) throw error;
      }
    }
  }

  throw new Error(
    `could not drain the access tokens of ${username} within ${MAX_TOKEN_PAGES} rounds`,
  );
}

/**
 * 監査に残す。定期実行の中なので、要求元の情報は持たない。
 *
 * 書けなくても処理は続ける。ここで投げると、片付けそのものが止まる。
 */
async function audit(action: string, details: string): Promise<void> {
  await createAuditLog({
    userId: null,
    action,
    details,
    ipAddress: null,
    userAgent: null,
    port: null,
  }).catch((error) => {
    console.error(`failed to record ${action}`, error);
  });
}

/**
 * 人の確認に回す。**管理画面から見えるように監査にも残す。**
 *
 * 行だけを NEEDS_REVIEW にしても、DB を直接見る人がいなければ誰も気付かない。
 * その間、退会したはずの利用者の Forgejo アカウントが残り続ける。
 */
async function sendToReview(
  userId: string,
  intentId: string,
  reason: string,
): Promise<boolean> {
  // 動かせなかったなら引き取られている。起きていないことを監査に書かない。
  if (
    !(await markGitAccountDeletionNeedsReview({ userId, intentId, reason }))
  ) {
    return false;
  }
  await audit(
    auditLogActions.git.accountNeedsReview,
    `userId: ${userId}; ${reason}`,
  );
  return true;
}

/**
 * 期限を延ばす。引き取られていたら投げて、そこで処理を止める。
 *
 * 握っていないのに消し続けると、引き取った側と 2 つで同じ相手を触ることになる。
 * どちらの操作も冪等だが、失敗の記録と監査が二重になって経緯が読めなくなる。
 */
async function renewLease(
  userId: string,
  intentId: string,
  phase: GitAccountDeletionPhase,
): Promise<void> {
  if (
    !(await renewGitAccountDeletionLease({
      userId,
      intentId,
      phase,
      leaseUntil: leaseDeadline(),
    }))
  ) {
    throw new GitAccountDeletionInProgressError(userId);
  }
}

/**
 * 退会処理を始める。意思表示を書き、身元を確かめ、トークンを失効させる。
 *
 * 対象が見つからなくても行は残す。**Git を使っていないように見えて、この直後に
 * 初回のプロビジョニングが走ることがある**ため。行があれば発行は止まるし、
 * 片付けの段になってもう一度探し直せる。
 */
export async function beginGitAccountDeletion(
  userId: string,
): Promise<{ forgejoUsername: string | null; intentId: string }> {
  // 対象を探す前に書く。探している間に初めての Forgejo ユーザーを作られると、
  // 誰も片付けないまま端末のトークンだけが残る。
  //
  // 返るのは「この行を持っている」id。同じ利用者の退会が同時に走ったら先勝ちで、
  // 後から来た方はここで相手の id を受け取る。取り消してよいのは自分の id のときだけ。
  const intentId = crypto.randomUUID();
  const marker = await startGitAccountDeletion({
    userId,
    intentId,
    leaseUntil: leaseDeadline(),
  });
  if (!marker.owned) {
    // 期限内の他人の印。乗らない。期限が切れていれば上で引き取れている。
    throw new GitAccountDeletionInProgressError(userId);
  }
  if (marker.tookOver) {
    // 前回の処理は印を立てた後に消えている。BLOCKING が残っている以上、
    // ユーザー削除は確定していない (同一トランザクションなので)。やり直す。
    console.warn(
      `took over an expired deletion marker for ${userId}; ` +
        "the previous attempt did not finish",
    );
  }

  try {
    const target = await resolveForgejoUser(userId);
    if (!target) return { forgejoUsername: null, intentId };

    // 控えを書けないなら、印は既に引き取られている。ここで進めても、相手の
    // 控えを上書きしないだけで、無駄に Forgejo を触ることになる。
    if (
      !(await setGitAccountDeletionTarget({
        userId,
        intentId,
        forgejoUsername: target.username,
        forgejoUserId: target.id,
      }))
    ) {
      throw new GitAccountDeletionInProgressError(userId);
    }
    await revokeAllTokens(target.username, () =>
      renewLease(userId, intentId, GitAccountDeletionPhase.BLOCKING),
    );
    return { forgejoUsername: target.username, intentId };
  } catch (error) {
    // 準備の段階で失敗した = 利用者はまだ生きている。印を残すと、その人は
    // 二度と資格情報を発行できなくなる。BLOCKING のうちだけ取り消す。
    await cancelPendingGitAccountDeletion({ userId, intentId }).catch(
      (cancelError) => {
        console.error(
          `failed to cancel the deletion marker of ${userId}; ` +
            "they cannot issue git credentials until it is removed",
          cancelError,
        );
      },
    );
    throw error;
  }
}

/**
 * 退会を取りやめる。Beutl 側の削除が失敗したときに呼ぶ。
 *
 * 自分が立てた BLOCKING の印だけを消す。呼ばないと、生き残った利用者が二度と
 * 資格情報を発行できなくなる。
 */
export async function abortGitAccountDeletion(
  userId: string,
  intentId: string,
): Promise<void> {
  await cancelPendingGitAccountDeletion({ userId, intentId }).catch((error) => {
    console.error(
      `failed to cancel the deletion marker of ${userId}; ` +
        "they cannot issue git credentials until it is removed",
      error,
    );
  });
}

/**
 * Forgejo のユーザーとリポジトリを消し、成功したら印を消す。
 *
 * 呼ぶ前に phase が READY_TO_PURGE であることを確かめる。BLOCKING のまま消すと、
 * ローカルの削除が失敗して生き残っている利用者のデータを落とすことになる。
 *
 * **必ず印を握ってから進める。** 握れなければ他の処理が進めているので何もしない。
 * 握った印 (epoch) で、以後の更新と purge の直前をすべて条件付ける。握らずに
 * 期限だけを見ると、期限切れで引き取られた側が息を吹き返したときに、引き取った側と
 * 同時に消しにいける。
 *
 * 対象は毎回探し直す。始めた時点では居なくても、その後に作られていることがある。
 * 見つかったら id とメールを確かめ直してから消す。待っている間に Forgejo が復元され、
 * 同じ名前が別人に渡っていることがあるため。
 *
 * @param heldIntentId 退会を始めた処理が握っている印。定期実行からは渡さない
 *   (期限切れの行を新しい印で引き取る)。
 * @returns 消し切れたかどうか。false なら再試行の対象として残る。
 */
export async function finishGitAccountDeletion(
  userId: string,
  heldIntentId?: string,
): Promise<boolean> {
  const pending = await findGitAccountDeletion({ userId });
  if (!pending) return true;
  if (pending.phase !== GitAccountDeletionPhase.READY_TO_PURGE) {
    // まだ Beutl 側が消えていないか、人の確認待ち。どちらもここでは進めない。
    return false;
  }

  // 進める前に握る。以後の更新はすべてこの epoch で条件付ける。
  let epoch: string;
  if (heldIntentId) {
    // 退会を始めた処理からの続き。まだ自分のものであることを確かめ、押さえ直す。
    // 待っている間に期限が切れて定期実行に引き取られていることがある。
    if (
      !(await renewGitAccountDeletionLease({
        userId,
        intentId: heldIntentId,
        phase: GitAccountDeletionPhase.READY_TO_PURGE,
        leaseUntil: leaseDeadline(),
      }))
    ) {
      return false;
    }
    epoch = heldIntentId;
  } else {
    // 定期実行。期限切れの行を**新しい印で**引き取る。前の持ち主はこれで
    // 以後 1 件も更新できなくなる。
    epoch = crypto.randomUUID();
    if (
      !(await claimGitAccountDeletion({
        userId,
        intentId: epoch,
        leaseUntil: leaseDeadline(),
      }))
    ) {
      return false;
    }
  }

  const expectedEmail = noreplyEmailFor(userId);
  let username = pending.forgejoUsername;

  try {
    // 控えた名前をまず見る。合成メールだけで探すと、Forgejo のホスト名が変わった
    // 場合などに「見つからない = 片付いた」と誤って結論してしまう。
    let actual = username
      ? await forgejoRequestOrNull<ForgejoUser>(
          `/users/${encodeURIComponent(username)}`,
        )
      : null;

    // 名前で見つからない、あるいは見つかったのが別人。どちらでも合成メールで
    // 引き直す。**名前だけで諦めない。** 改名された本人が、生きたトークンごと
    // 残っていることがある。合成メールは userId から決まるので名前に依らない。
    const wrongPerson =
      actual !== null &&
      ((pending.forgejoUserId !== null &&
        pending.forgejoUserId !== actual.id) ||
        actual.email !== expectedEmail);
    if (!actual || wrongPerson) {
      const byEmail = await findByNoreplyEmail(userId);
      if (byEmail) {
        username = byEmail.username;
        actual = await forgejoRequestOrNull<ForgejoUser>(
          `/users/${encodeURIComponent(username)}`,
        );
        // **ここでは控えない。** 本人だと確かめる前に上書きすると、控えていた
        // 元の id が失われ、食い違いの記録が lastError の文字列だけになる。
        // 控えるのは下の 2 点照合を通った後。
      } else if (wrongPerson) {
        // 名前は別人のもので、本人はメールでも見つからない。**消しにいかない**。
        // かといって消せた証拠も無いので、完了にもしない。
        await sendToReview(
          userId,
          epoch,
          `Forgejo user ${pending.forgejoUsername} is now a different account ` +
            `and no account matches <${expectedEmail}>`,
        );
        return false;
      } else {
        actual = null;
      }
    }

    if (!actual) {
      if (!pending.forgejoUsername) {
        // 控えにも無く、Forgejo にも居ない。Git を一度も使わなかった利用者。
        // 片付けるものが無いので完了。墓標を残す相手もいない。
        return await deleteGitAccountDeletion({ userId, intentId: epoch });
      }
      // 控えた相手は居ない。名前でもメールでも見つからないので、消えている。
      return await markGitAccountDeletionPurged({ userId, intentId: epoch });
    }

    // 消す相手が本人かを確かめ直す。**id と合成メールの両方**が控えと一致する
    // ことを求める。削除は取り返しがつかないので、通常操作より 1 つ厳しくする。
    //
    // 復元でアカウントが戻っても id は変わらない (同じ行が戻るため)。id が違うのは
    // 「消して作り直された」など、こちらの控えでは説明が付かない事態なので、
    // 消しにいかず人に確かめてもらう。
    //
    // 控えに id が無いのは、対応表を失った状態で合成メールから引き当てた古い行。
    // その場合はメールだけで判断する (それ以外に手掛かりが無い)。
    const idMatches =
      pending.forgejoUserId === null || pending.forgejoUserId === actual.id;
    if (!idMatches || actual.email !== expectedEmail) {
      await sendToReview(
        userId,
        epoch,
        `Forgejo user ${username} is id ${actual.id} <${actual.email}>, ` +
          `expected id ${pending.forgejoUserId} <${expectedEmail}>`,
      );
      return false;
    }
    username = actual.login;

    // 本人だと確かめたので控える。控えないと、この後の墓標が誰を指すのか
    // 分からなくなり、復活の照合から外れる。
    if (
      pending.forgejoUsername !== actual.login ||
      pending.forgejoUserId !== actual.id
    ) {
      await setGitAccountDeletionTarget({
        userId,
        intentId: epoch,
        forgejoUsername: actual.login,
        forgejoUserId: actual.id,
      });
    }

    // 掃き直す。意思表示の前に始まっていた発行が着地していることがある。
    await revokeAllTokens(username, () =>
      renewLease(userId, epoch, GitAccountDeletionPhase.READY_TO_PURGE),
    );

    // **消す直前にもう一度握りを確かめる。** ここまでの間に引き取られていたら、
    // 引き取った側が別人と判定して人の確認待ちに移しているかもしれない。
    // 完全に防げるわけではない (この確認と DELETE の間は開いたまま) が、
    // 開いている幅を 1 往復に縮められる。
    await renewLease(userId, epoch, GitAccountDeletionPhase.READY_TO_PURGE);

    await forgejoRequest(`/admin/users/${encodeURIComponent(username)}`, {
      method: "DELETE",
      // リポジトリを持っているユーザーは purge を付けないと 422 で拒まれる。
      searchParams: { purge: true },
      responseType: "none",
    });
  } catch (error) {
    if (!(error instanceof ForgejoError && error.isNotFound)) {
      await recordGitAccountDeletionAttempt({
        userId,
        intentId: epoch,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      console.error(
        `failed to finish deleting the Forgejo account of ${userId}; ` +
          "it stays queued in GitAccountDeletion for retry",
        error,
      );
      return false;
    }
  }

  // **行は消さない。** 消した相手を控え続け、復元で復活していないかを照合する。
  return await markGitAccountDeletionPurged({ userId, intentId: epoch });
}

/**
 * 退会を始めたまま消えた処理の後始末。
 *
 * BLOCKING の印は、立てた処理がユーザー削除まで辿り着かなかったことを意味する
 * (削除と READY_TO_PURGE への遷移は同一トランザクションなので、BLOCKING が
 * 残っている = 削除は確定していない)。期限が切れているならその処理はもう居ない。
 * 外さないと、その利用者は資格情報の発行も、やり直しの退会もできない。
 *
 * ただし**利用者が本当に生きているかを毎回確かめてから外す**。消えているのに
 * BLOCKING が残っているなら、同一トランザクションの前提が崩れているか、この経路の
 * 外でユーザーが消されている。どちらも自動で判断してよい状態ではないので、
 * 人の確認に回す。
 *
 * @returns 外した件数と、人の確認に回した件数。
 */
export async function releaseExpiredGitAccountDeletionBlocks({
  limit = 20,
}: { limit?: number } = {}): Promise<{ released: number; review: number }> {
  const expiredBefore = new Date();
  const stuck = await listExpiredGitAccountDeletionBlocks({
    expiredBefore,
    limit,
  });
  let released = 0;
  let review = 0;

  for (const entry of stuck) {
    if (!(await existsUserById({ id: entry.userId }))) {
      // 見てから今までに引き取られていたら false。数にも入れない。
      if (
        await sendToReview(
          entry.userId,
          entry.intentId,
          "the user is gone but the marker never reached READY_TO_PURGE; " +
            "the Forgejo account may still exist",
        )
      ) {
        review += 1;
      }
      continue;
    }

    // 見た行と同じであることを確かめてから外す。見てから外すまでの間に
    // 新しい退会が始まっていたら、その印を消してしまう。
    if (
      await releaseGitAccountDeletionBlock({
        userId: entry.userId,
        intentId: entry.intentId,
        expiredBefore,
      })
    ) {
      released += 1;
      await audit(
        auditLogActions.git.deletionMarkerReleased,
        `userId: ${entry.userId}; the attempt that created it never finished`,
      );
    }
  }

  return { released, review };
}

/**
 * 復活していないかを照合する間隔。全件を毎回当たると Forgejo への往復が増える。
 * 復元は稀な事象なので、数時間ごとに回れば十分。
 */
const TOMBSTONE_RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * 消したはずの Forgejo アカウントが戻っていないかを見る。
 *
 * **Forgejo だけを退会前の時点に戻すと、ユーザーもリポジトリも端末のトークンも
 * 復活する。** beutl-web 側には利用者も進行中の行も残っていないので、墓標が
 * 無ければ誰も気付けない。git と LFS は Caddy を素通りして Forgejo が直接
 * 認証するので、復活したトークンはそのまま使える。
 *
 * 墓標の相手をもう一度引き、居れば消し直す。消しにいく前に、
 *
 *   - Beutl 側の利用者が復活していないか (復活していれば、戻したのは beutl-web の
 *     方。その人は生きているので**消してはいけない**)
 *   - 控えた id と合成メールが一致するか (名前を再利用した別人を消さないため)
 *
 * を確かめる。どちらかで判断が付かなければ人の確認に回す。
 *
 * @returns 消し直した件数と、人の確認に回した件数。
 */
export async function reconcileGitAccountDeletionTombstones({
  limit = 20,
  /** 見るものが無くなるまで繰り返す。復元の直後に一巡させるため。 */
  drain = false,
}: { limit?: number; drain?: boolean } = {}): Promise<{
  checked: number;
  repurged: number;
  review: number;
  failed: number;
  remaining: number;
}> {
  const checkedBefore = new Date(Date.now() - TOMBSTONE_RECHECK_MS);
  // 今の復元世代。確認した墓標にこれを書く。復元の後、全件を見直したことを
  // 時計に頼らず数えられるようにするため。
  const generation = await currentGitRestoreGeneration();
  let checked = 0;
  let repurged = 0;
  let review = 0;
  let failed = 0;

  // 1 周ぶんを処理する。drain なら、対象が無くなるまで繰り返す。
  // 上限は暴走よけ。1 周で 1 件も進まなければ抜ける。
  for (let round = 1; round <= (drain ? 200 : 1); round++) {
    const tombstones = await listPurgedGitAccountDeletions({
      checkedBefore,
      generation,
      limit,
    });
    if (tombstones.length === 0) break;
    let progressed = 0;

    for (const tombstone of tombstones) {
      let username = tombstone.forgejoUsername;
      if (!username) continue;

      // 掴んでから進める。照合の途中で別の実行が同じ相手を消しにいかないように。
      const epoch = crypto.randomUUID();
      if (
        !(await claimGitAccountDeletion({
          userId: tombstone.userId,
          intentId: epoch,
          phase: GitAccountDeletionPhase.PURGED,
          leaseUntil: leaseDeadline(),
        }))
      ) {
        continue;
      }

      try {
        let actual = await forgejoRequestOrNull<ForgejoUser>(
          `/users/${encodeURIComponent(username)}`,
        );
        if (!actual) {
          // 控えた名前では見つからない。ただし復元先で名前が違うことがあるので、
          // 合成メールでも引く。ここを飛ばすと、同じ人が別名で生き返っていても
          // 「消えたまま」と結論してしまう。
          const byEmail = await findByNoreplyEmail(tombstone.userId);
          if (!byEmail) {
            await touchGitAccountDeletion({
              userId: tombstone.userId,
              intentId: epoch,
              generation,
            });
            checked += 1;
            progressed += 1;
            continue;
          }
          username = byEmail.username;
          actual = await forgejoRequestOrNull<ForgejoUser>(
            `/users/${encodeURIComponent(username)}`,
          );
          if (!actual) {
            await touchGitAccountDeletion({
              userId: tombstone.userId,
              intentId: epoch,
              generation,
            });
            checked += 1;
            progressed += 1;
            continue;
          }
        }

        // Beutl 側の利用者が戻っているなら、復元されたのは beutl-web の方。
        // その人は生きているので消してはいけない。墓標の方が古い。
        if (await existsUserById({ id: tombstone.userId })) {
          if (
            await sendToReview(
              tombstone.userId,
              epoch,
              `the Beutl user exists again while ${username} was recorded as purged; ` +
                "beutl-web was probably restored to a point before the deletion",
            )
          ) {
            review += 1;
          }
          checked += 1;
          progressed += 1;
          continue;
        }

        const expectedEmail = noreplyEmailFor(tombstone.userId);

        // 控えた名前が別人のものになっていることがある。その場合でも、本人が
        // 別名で生き返っていないかを合成メールで確かめる。諦めると、名前を
        // 取られた本人の復活を永久に見逃す。
        if (actual.email !== expectedEmail) {
          const byEmail = await findByNoreplyEmail(tombstone.userId);
          const renamed = byEmail
            ? await forgejoRequestOrNull<ForgejoUser>(
                `/users/${encodeURIComponent(byEmail.username)}`,
              )
            : null;
          if (!renamed || renamed.email !== expectedEmail) {
            // このメールを持つアカウントはどこにも無い。消えたままで確定。
            await touchGitAccountDeletion({
              userId: tombstone.userId,
              intentId: epoch,
              generation,
            });
            checked += 1;
            progressed += 1;
            continue;
          }
          username = renamed.login;
          actual = renamed;
        }

        // ここから先、相手は「この利用者のメールを持つアカウント」。**消えては
        // いない。** 控えた id と食い違う場合、消して作り直されたのか、復元の
        // 仕方が違うのか、こちらの控えでは説明が付かない。
        //
        // **確認済みにしてはいけない。** 生きたトークンを残したまま「見終わった」
        // と数えると、復元後の公開判定がそれを 0 と読む。人の確認に回す。
        if (
          tombstone.forgejoUserId !== null &&
          tombstone.forgejoUserId !== actual.id
        ) {
          if (
            await sendToReview(
              tombstone.userId,
              epoch,
              `Forgejo user ${username} holds <${expectedEmail}> but is id ` +
                `${actual.id}, recorded as ${tombstone.forgejoUserId}`,
            )
          ) {
            review += 1;
          }
          checked += 1;
          progressed += 1;
          continue;
        }

        // 復活している。端末のトークンも一緒に戻っているので、消し直す。
        await revokeAllTokens(username, () =>
          renewLease(tombstone.userId, epoch, GitAccountDeletionPhase.PURGED),
        );
        await renewLease(
          tombstone.userId,
          epoch,
          GitAccountDeletionPhase.PURGED,
        );
        await forgejoRequest(`/admin/users/${encodeURIComponent(username)}`, {
          method: "DELETE",
          searchParams: { purge: true },
          responseType: "none",
        });
        await markGitAccountDeletionPurged({
          userId: tombstone.userId,
          intentId: epoch,
          generation,
        });
        await audit(
          auditLogActions.git.accountResurrected,
          `userId: ${tombstone.userId}; Forgejo user ${username} (id ${actual.id}) ` +
            "came back after being purged and was removed again",
        );
        repurged += 1;
        checked += 1;
        progressed += 1;
      } catch (error) {
        failed += 1;
        // 見終わっていないので lastAttemptAt は進めない (進めるとやり残しが
        // 見終わったように見える)。試行回数と理由だけ残す。
        await recordGitAccountDeletionAttempt({
          userId: tombstone.userId,
          intentId: epoch,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
        console.error(
          `failed to reconcile the purge tombstone of ${tombstone.userId}`,
          error,
        );
      }
    }

    // 1 件も進まなかった (全部失敗か、全部他の実行が握っている)。回し続けない。
    if (progressed === 0) break;
  }

  return {
    checked,
    repurged,
    review,
    failed,
    remaining: await countPurgedGitAccountDeletionsToCheck({
      checkedBefore,
      generation,
    }),
  };
}

/**
 * 片付け待ちを拾って再試行する。定期実行から呼ぶ。
 *
 * 掴んだ行は期限で押さえる。長引く場合は処理の中から延ばすので、重なった実行が
 * 同じ相手を触ることはない。落ちた場合は期限切れとして次の実行が引き取る。
 *
 * @returns 片付いた件数、まだ残っている件数、人の確認待ちの件数。
 */
export async function retryPendingGitDeletions({
  limit = 20,
}: { limit?: number } = {}): Promise<{
  finished: number;
  pending: number;
  review: number;
}> {
  const pending = await listPendingGitAccountDeletions({ limit });
  let finished = 0;

  for (const entry of pending) {
    // 掴むのは finishGitAccountDeletion の中。ここで掴んでから渡すと、掴んだ印を
    // 渡す手段が要るうえ、渡し忘れれば握っていない処理が消しにいける。
    // 掴めなかった場合も false が返るので、片付いていない件数として数えられる。
    if (await finishGitAccountDeletion(entry.userId)) {
      finished += 1;
    }
  }

  return {
    finished,
    // 1 回分ではなく残っている総数。上限で切った分を 0 と報告しない。
    pending: await countGitAccountDeletions({
      phase: GitAccountDeletionPhase.READY_TO_PURGE,
    }),
    review: await countGitAccountDeletionsNeedingReview(),
  };
}
