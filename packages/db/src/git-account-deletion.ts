import { GitAccountDeletionPhase } from "@prisma/client";
import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * 退会処理の途中経過。Forgejo 側を消し切るまで残る。
 *
 * phase の意味は 1 つずつしかない。
 *   BLOCKING       退会を始めた。資格情報の発行を止める。**まだ purge しない**
 *   READY_TO_PURGE Beutl 側のユーザーが実際に消えた。purge してよい
 *   NEEDS_REVIEW   自動では決着できない。人が確認するまで触らない
 *
 * BLOCKING のまま purge すると、ローカルの削除が失敗して生き残った利用者の
 * Forgejo アカウントとリポジトリを消すことになる。
 *
 * `leaseUntil` は「今この行を進めている処理が生きているとみなす期限」。
 * 期限内は他の処理が触らない。期限切れは、握っていた処理が落ちた印なので
 * 引き取ってよい。これが無いと、印を立てた直後に Worker が落ちただけで
 * BLOCKING が永久に残り、その利用者は退会も資格情報の発行もできなくなる。
 */

export { GitAccountDeletionPhase };

/** 期限切れ (NULL を含む) を表す where 断片。NULL は移行前の行と、期限を持たない行。 */
function leaseExpired(now: Date) {
  return {
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
  };
}

/**
 * 退会の意思表示。対象がまだ分からない段階でも書ける。
 *
 * @returns `owned` は、この呼び出しがこの行を握ったかどうか。同じ利用者の退会が
 *   同時に走ると 1 つの行を共有するので、先に立てた方だけが true になる。
 *   **false のとき、この行は他人のもの**。取り消しても READY にしてもいけない。
 *   `tookOver` は、期限切れの印を引き取った場合に true。
 */
export async function startGitAccountDeletion({
  userId,
  intentId,
  leaseUntil,
  now = new Date(),
  prisma,
}: {
  userId: string;
  intentId: string;
  leaseUntil: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<{ intentId: string; owned: boolean; tookOver: boolean }> {
  const db = prisma ?? (await getDb());

  // 1. 期限切れの BLOCKING があれば引き取る。条件付き更新なので、同時に来た
  //    2 つのうち 1 つしか成立しない (負けた方は期限が先に進んだ行を見る)。
  //
  //    引き取ってよいのは BLOCKING だけ。ユーザー削除と READY_TO_PURGE への
  //    遷移は同一トランザクションなので、BLOCKING が残っている = ユーザーは
  //    まだ生きている。READY_TO_PURGE と NEEDS_REVIEW は既に利用者が消えた後で、
  //    新しい退会要求が乗ってよい状態ではない。
  const { count } = await db.gitAccountDeletion.updateMany({
    where: {
      userId,
      phase: GitAccountDeletionPhase.BLOCKING,
      ...leaseExpired(now),
    },
    data: {
      intentId,
      leaseUntil,
      attempts: { increment: 1 },
      lastAttemptAt: now,
      lastError: "前の退会処理が期限までに終わらなかったため引き取りました",
    },
  });
  if (count === 1) {
    return { intentId, owned: true, tookOver: true };
  }

  // 2. 無ければ立てる。既にあれば、それは期限内の他人の印。phase も intentId も
  //    触らない (READY_TO_PURGE を BLOCKING に落とすと、既に消えた利用者の
  //    後始末が二度と進まなくなる)。
  const row = await db.gitAccountDeletion.upsert({
    where: { userId },
    create: { userId, intentId, leaseUntil },
    update: {},
  });
  return {
    intentId: row.intentId,
    owned: row.intentId === intentId,
    tookOver: false,
  };
}

/**
 * 握っている期限を延ばす。**自分の印であるときだけ**通る。
 *
 * トークンの失効は本数に比例して時間がかかる。延ばさないと、作業中に期限が切れて
 * 別の処理に引き取られ、2 つが同じ相手を消しにいく。
 *
 * `phase` も見る。読んだ時点から今までに人の確認待ちへ移っていた場合、同じ
 * intentId のままでも進めてはいけない。
 *
 * @returns まだ自分が握っているかどうか。false なら引き取られたか、状態が変わった。
 */
export async function renewGitAccountDeletionLease({
  userId,
  intentId,
  phase,
  leaseUntil,
  prisma,
}: {
  userId: string;
  intentId: string;
  phase: GitAccountDeletionPhase;
  leaseUntil: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    where: { userId, intentId, phase },
    data: { leaseUntil },
  });
  return count === 1;
}

/**
 * Forgejo 側の対象が分かったら記録する。**自分が握っている行だけ**。
 *
 * userId だけで書くと、期限切れで引き取られた後の処理が、引き取った側の控えを
 * 上書きできてしまう。
 */
export async function setGitAccountDeletionTarget({
  userId,
  intentId,
  forgejoUsername,
  forgejoUserId,
  prisma,
}: {
  userId: string;
  intentId: string;
  forgejoUsername: string;
  forgejoUserId: number;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    where: { userId, intentId },
    data: { forgejoUsername, forgejoUserId },
  });
  return count === 1;
}

/**
 * purge してよい状態にする。
 *
 * **ユーザー削除と同じトランザクションで呼ぶこと。** 別々にすると、ユーザーが
 * 残っているのに purge 可能な行だけができる瞬間があり、そこで再試行が走ると
 * 生きている利用者の Git データを消す。
 */
export async function markGitAccountDeletionReady({
  userId,
  intentId,
  prisma,
}: {
  userId: string;
  intentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    // 自分が立てた印であることまで見る。他人の印に乗って進めると、その相手が
    // 失敗して印を取り消したときに、後始末できないままユーザーだけが消える。
    where: { userId, intentId },
    data: { phase: GitAccountDeletionPhase.READY_TO_PURGE },
  });

  // 印が消えていたら (あるいは引き取られていたら) ユーザーを消してはいけない。
  // 誰も後始末できなくなり、その間に発行されたトークンが Forgejo に残ったままになる。
  // 呼び出し元は同じトランザクションなので、投げれば削除ごと巻き戻る。
  if (count !== 1) {
    throw new Error(
      `expected exactly one GitAccountDeletion for ${userId} with intent ` +
        `${intentId}, updated ${count}`,
    );
  }
}

/**
 * 自動では決着できない状態にする。
 * 控えの相手が見つからない、あるいは別人になっている場合。人が確認するまで放置する。
 */
export async function markGitAccountDeletionNeedsReview({
  userId,
  intentId,
  reason,
  prisma,
}: {
  userId: string;
  /** 握っている印。これを持っていない処理が状態を動かすと、引き取った側と食い違う。 */
  intentId: string;
  reason: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    where: { userId, intentId },
    data: {
      phase: GitAccountDeletionPhase.NEEDS_REVIEW,
      // 人の判断待ちなので期限は持たせない。自動で引き取られないようにする。
      leaseUntil: null,
      lastAttemptAt: new Date(),
      lastError: reason.slice(0, 500),
    },
  });
  return count === 1;
}

/**
 * まだ BLOCKING の印を取り消す。
 *
 * 退会の準備段階で失敗すると利用者は残るので、印だけ残ると資格情報を二度と
 * 発行できなくなる。READY_TO_PURGE 以降は消さない (Beutl 側は既に消えている)。
 */
export async function cancelPendingGitAccountDeletion({
  userId,
  intentId,
  prisma,
}: {
  userId: string;
  intentId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitAccountDeletion.deleteMany({
    // **自分が立てた印だけ**。同じ利用者の退会が 2 本走ると 1 つの行を共有するので、
    // 片方の失敗で消すと、進行中のもう片方が印を失ったまま利用者を削除してしまう。
    where: { userId, intentId, phase: GitAccountDeletionPhase.BLOCKING },
  });
}

export async function findGitAccountDeletion({
  userId,
  prisma,
}: {
  userId: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.findUnique({ where: { userId } });
}

/**
 * 片付いた印を消す。
 *
 * `intentId` を渡すと自分が握っている行だけを消す。引き取られた後の処理が、
 * 引き取った側の記録 (人の確認待ちに移した行など) を消さないようにするため。
 */
export async function deleteGitAccountDeletion({
  userId,
  intentId,
  prisma,
}: {
  userId: string;
  intentId?: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.deleteMany({
    where: { userId, ...(intentId === undefined ? {} : { intentId }) },
  });
  return count === 1;
}

/**
 * 片付け待ちを古い順に返す。**READY_TO_PURGE だけ**。
 * BLOCKING はまだ利用者が生きている可能性があるので、決して混ぜない。
 *
 * 期限が残っているものは飛ばす。別の実行が今まさに進めている。
 */
export async function listPendingGitAccountDeletions({
  limit = 20,
  now = new Date(),
  prisma,
}: {
  limit?: number;
  now?: Date;
  prisma?: PrismaTransaction;
} = {}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.findMany({
    where: {
      phase: GitAccountDeletionPhase.READY_TO_PURGE,
      ...leaseExpired(now),
    },
    orderBy: [{ attempts: "asc" }, { createdAt: "asc" }],
    take: limit,
  });
}

/**
 * 期限切れの片付け待ちを引き取る。**intentId を新しいものに差し替える**。
 *
 * 期限を延ばすだけでは足りない。前の持ち主は自分の intentId を握ったままなので、
 * 期限が切れた後に息を吹き返しても renew に成功してしまい、引き取った側と同時に
 * トークンの失効と purge を進められる。相手が別人と判定して人の確認待ちに移した
 * 後でさえ、消しにいける。差し替えれば、前の持ち主のその後の更新は 1 件も通らない。
 *
 * 条件付き更新なので、同時に始まった定期実行のうち 1 つしか掴めない。処理が長引く
 * ときは renewGitAccountDeletionLease で延ばす。
 *
 * @returns 掴めたかどうか。
 */
export async function claimGitAccountDeletion({
  userId,
  intentId,
  phase = GitAccountDeletionPhase.READY_TO_PURGE,
  leaseUntil,
  now = new Date(),
  prisma,
}: {
  userId: string;
  /** この実行が握る新しい印。以後の更新はすべてこれで条件付ける。 */
  intentId: string;
  /** 掴む対象の状態。片付け待ちと、復活の照合待ち (PURGED) で使う。 */
  phase?: GitAccountDeletionPhase;
  leaseUntil: Date;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    where: { userId, phase, ...leaseExpired(now) },
    // **lastAttemptAt は進めない。** 掴んだだけで「見た」ことにすると、途中で
    // 失敗した相手も見終わったように見え、一巡したかどうかを数えられなくなる。
    // 重なった実行を防ぐのは leaseUntil の役目。
    data: { intentId, leaseUntil },
  });
  return count === 1;
}

/**
 * 消し終えた印を残す。**行は消さない。**
 *
 * Forgejo だけを退会前の時点に戻すと、ユーザーもリポジトリも端末のトークンも
 * 復活する。beutl-web 側には利用者も行も残っていないので、消したという記録が
 * 無ければ復活に誰も気付けず、Caddy を素通りする git 経路でそのトークンが使える。
 * 消した相手を控え続け、後から照合できるようにする。
 */
export async function markGitAccountDeletionPurged({
  userId,
  intentId,
  now = new Date(),
  prisma,
}: {
  userId: string;
  intentId: string;
  now?: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    where: { userId, intentId },
    data: {
      phase: GitAccountDeletionPhase.PURGED,
      purgedAt: now,
      // 照合は間隔を空けて回す。掴み直せるように期限は持たせない。
      leaseUntil: null,
      lastAttemptAt: now,
      lastError: null,
    },
  });
  return count === 1;
}

/**
 * 復活していないかを見る対象を古い順に返す。
 *
 * @param checkedBefore これより後に見たものは飛ばす。毎回全件を当たらないため。
 */
export async function listPurgedGitAccountDeletions({
  checkedBefore,
  limit = 20,
  now = new Date(),
  prisma,
}: {
  checkedBefore: Date;
  limit?: number;
  now?: Date;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.findMany({
    where: {
      phase: GitAccountDeletionPhase.PURGED,
      // 控えた相手が分からない行は照合しようがない。
      forgejoUsername: { not: null },
      ...leaseExpired(now),
      OR: [
        { lastAttemptAt: null },
        { lastAttemptAt: { lt: checkedBefore } },
      ],
    },
    orderBy: [{ lastAttemptAt: "asc" }, { purgedAt: "asc" }],
    take: limit,
  });
}

/**
 * まだ見ていない墓標の件数。
 *
 * 復元の後、全件を見終わったかを外から判定するために使う。掴んだ時点では
 * `lastAttemptAt` を進めないので、この数が 0 になったことが一巡の証拠になる。
 */
export async function countPurgedGitAccountDeletionsToCheck({
  checkedBefore,
  prisma,
}: {
  checkedBefore: Date;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.count({
    where: {
      phase: GitAccountDeletionPhase.PURGED,
      forgejoUsername: { not: null },
      OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: checkedBefore } }],
    },
  });
}

/** 見たという印だけ付ける。状態は変えない。 */
export async function touchGitAccountDeletion({
  userId,
  intentId,
  prisma,
}: {
  userId: string;
  intentId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.updateMany({
    where: { userId, intentId },
    data: { lastAttemptAt: new Date(), leaseUntil: null },
  });
  return count === 1;
}

/**
 * 期限が切れた BLOCKING の印を古い順に返す。
 *
 * これがある = 退会を始めた処理が、ユーザー削除まで辿り着かずに消えた。
 * 放っておくと、その利用者は退会も資格情報の発行もできない。
 */
export async function listExpiredGitAccountDeletionBlocks({
  expiredBefore,
  limit = 20,
  prisma,
}: {
  expiredBefore: Date;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.findMany({
    where: {
      phase: GitAccountDeletionPhase.BLOCKING,
      ...leaseExpired(expiredBefore),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

/**
 * 期限切れの BLOCKING を外す。
 *
 * 見た時点と同じ行であることを intentId と期限で確かめてから消す。確かめずに消すと、
 * 見てから消すまでの間に始まった新しい退会処理の印を消してしまう。
 *
 * @returns 外せたかどうか。false なら誰かが先に引き取っている。
 */
export async function releaseGitAccountDeletionBlock({
  userId,
  intentId,
  expiredBefore,
  prisma,
}: {
  userId: string;
  intentId: string;
  expiredBefore: Date;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitAccountDeletion.deleteMany({
    where: {
      userId,
      intentId,
      phase: GitAccountDeletionPhase.BLOCKING,
      ...leaseExpired(expiredBefore),
    },
  });
  return count === 1;
}

/** 状態ごとの件数。1 回分の処理数ではなく、残っている総数を数えるために使う。 */
export async function countGitAccountDeletions({
  phase,
  prisma,
}: {
  phase: GitAccountDeletionPhase;
  prisma?: PrismaTransaction;
}): Promise<number> {
  const db = prisma ?? (await getDb());
  return await db.gitAccountDeletion.count({ where: { phase } });
}

/** 人の確認待ちの件数。0 でないなら誰かが見に行く必要がある。 */
export async function countGitAccountDeletionsNeedingReview({
  prisma,
}: { prisma?: PrismaTransaction } = {}): Promise<number> {
  return await countGitAccountDeletions({
    phase: GitAccountDeletionPhase.NEEDS_REVIEW,
    prisma,
  });
}

/**
 * 失敗を記録する。
 *
 * **`lastAttemptAt` は進めない。** これは「見終わった時刻」で、失敗は見終わって
 * いない。進めてしまうと、復元の後に全件を見終わったかを数えられなくなる
 * (やり残しが見終わったように見える)。重なった実行を防ぐのは leaseUntil の役目。
 */
export async function recordGitAccountDeletionAttempt({
  userId,
  intentId,
  error,
  prisma,
}: {
  userId: string;
  /** 握っている印。引き取られた後の処理が記録を上書きしないようにする。 */
  intentId: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitAccountDeletion.updateMany({
    where: { userId, intentId },
    data: {
      attempts: { increment: 1 },
      // 例外の文字列は長くなりうる。原因が分かる範囲で切る。
      lastError: error.slice(0, 500),
    },
  });
}
