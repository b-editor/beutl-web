import { getDb } from "./provider";
import type { PrismaTransaction } from "./transaction";

/**
 * 復元で生き返るものの墓標。
 *
 * 退会 (GitAccountDeletion) と違い、こちらは**こちら側に何も残らない操作**の控え。
 * トークンを 1 本失効させると GitCredential の行ごと消え、リポジトリを消せば
 * Forgejo にも DB にも何も残らない。Forgejo をその前の時点へ戻すと、失効した
 * はずのトークン (端末には平文が残っている) と、消したはずのリポジトリが復活する。
 * 控えが無ければ、それを消し直したかどうかを誰も数えられない。
 */

/**
 * 失効させたトークンを控える。**Forgejo を触る前に書く。**
 *
 * この時点では `confirmed` は false。消えたことを確かめてから立てる。
 * @returns 控えの id。
 */
export async function recordGitCredentialRevocation({
  userId,
  credentialId,
  forgejoUsername,
  forgejoTokenId,
  lastEight,
  prisma,
}: {
  userId: string;
  credentialId: string;
  forgejoUsername: string;
  forgejoTokenId: number;
  lastEight: string;
  prisma?: PrismaTransaction;
}): Promise<string> {
  const db = prisma ?? (await getDb());
  const row = await db.gitCredentialRevocation.create({
    data: { userId, credentialId, forgejoUsername, forgejoTokenId, lastEight },
  });
  return row.id;
}

/** Forgejo から消えたことを確かめた。ここから消し直しの対象になる。 */
export async function confirmGitCredentialRevocation({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitCredentialRevocation.updateMany({
    where: { id },
    data: { confirmed: true },
  });
}

/**
 * 失効が**行われなかった**と分かった。控えごと外す。
 *
 * 残すと、断られた失効を定期実行が後から実行することになる。
 */
export async function dropGitCredentialRevocation({
  id,
  prisma,
}: {
  id: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitCredentialRevocation.deleteMany({
    where: { id, confirmed: false },
  });
}

/** まだ確かめていない控え。消えたかどうかを見て、確定させるか外すかを決める。 */
export async function listUnconfirmedGitCredentialRevocations({
  limit = 20,
  prisma,
}: { limit?: number; prisma?: PrismaTransaction } = {}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredentialRevocation.findMany({
    where: { confirmed: false, baseline: false },
    orderBy: [{ revokedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

/** 消したリポジトリを控える。**Forgejo を触る前に書く。** */
export async function recordGitRepositoryDeletion({
  forgejoRepoId,
  ownerUsername,
  name,
  prisma,
}: {
  forgejoRepoId: number;
  ownerUsername: string;
  name: string;
  prisma?: PrismaTransaction;
}): Promise<{ id: string; intentId: string }> {
  const db = prisma ?? (await getDb());
  // **上書きしない。消去 1 回につき 1 行を積む。**
  //
  // 復元で採番がやり直されると、同じ id を別のリポジトリが持つ。上書きすると
  // 前の相手の「確かめ済み」の控えが消え、その相手が生き返っても追えなくなる。
  const row = await db.gitRepositoryDeletion.create({
    data: { intentId: crypto.randomUUID(), forgejoRepoId, ownerUsername, name },
  });
  return { id: row.id, intentId: row.intentId };
}

/**
 * Forgejo から消えたことを確かめた。ここから消し直しの対象になる。
 *
 * **自分が積んだ行だけ**に効く。期限切れの処理が読んだ後に前面がやり直した場合、
 * 古い方の書き込みは 1 件も通らない。
 */
export async function confirmGitRepositoryDeletion({
  id,
  intentId,
  prisma,
}: {
  id: string;
  intentId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryDeletion.updateMany({
    where: { id, intentId, baseline: false },
    data: { confirmed: true },
  });
  return count === 1;
}

/**
 * 削除が**行われなかった**と分かった。控えごと外す。
 *
 * 残すと、403 や 422 で断られた削除を定期実行が後から実行し、利用者のリポジトリを
 * 消してしまう。
 */
export async function dropGitRepositoryDeletion({
  id,
  intentId,
  prisma,
}: {
  id: string;
  intentId: string;
  prisma?: PrismaTransaction;
}): Promise<boolean> {
  const db = prisma ?? (await getDb());
  const { count } = await db.gitRepositoryDeletion.deleteMany({
    // **確かめていない、自分の行だけ。** 確かめた行を消すと、生き返っても
    // 追えなくなる。仕組みが入る前の行 (baseline) も人が見るまで消さない。
    where: { id, intentId, confirmed: false, baseline: false },
  });
  return count === 1;
}

/** まだ確かめていない控え。 */
export async function listUnconfirmedGitRepositoryDeletions({
  limit = 20,
  prisma,
}: { limit?: number; prisma?: PrismaTransaction } = {}) {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryDeletion.findMany({
    // 仕組みが入る前の行は自動では触らない。人が Forgejo 側を確かめる。
    where: { confirmed: false, baseline: false },
    orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

/**
 * この世代でまだ確認していない失効の控え。
 *
 * 世代を渡さない場合は「一度も確認していないもの」。復元が一度も無い間は、
 * ここを回す必要が無い (生き返る機会が無いので)。
 */
export async function listGitCredentialRevocations({
  generation,
  limit = 20,
  prisma,
}: {
  generation: string | null;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitCredentialRevocation.findMany({
    // **確かめたものだけ。** 控えを書いただけのものを消しにいくと、断られた
    // 失効を後から実行することになる。
    where: { confirmed: true, baseline: false, ...notCheckedIn(generation) },
    orderBy: [{ revokedAt: "asc" }, { id: "asc" }],
    take: limit,
  });
}

export async function listGitRepositoryDeletions({
  generation,
  limit = 20,
  prisma,
}: {
  generation: string | null;
  limit?: number;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  return await db.gitRepositoryDeletion.findMany({
    // **確かめたものだけ。** 断られた削除を後から実行しないため。
    where: {
      confirmed: true,
      needsReview: false,
      baseline: false,
      ...notCheckedIn(generation),
    },
    orderBy: [{ deletedAt: "asc" }, { forgejoRepoId: "asc" }],
    take: limit,
  });
}

/**
 * 「この世代で確認していない」の条件。
 *
 * 時計では数えない。復元ごとに世代を 1 つ登録し、確認した控えにその世代を書く。
 * 時刻で比べると、Worker と DB の時計のずれや、復元前に行った確認を取り違える。
 */
function notCheckedIn(generation: string | null) {
  return generation === null
    ? { checkedGeneration: null }
    : {
        OR: [
          { checkedGeneration: null },
          { checkedGeneration: { not: generation } },
        ],
      };
}

/** 確認できた。この世代の分は終わり。 */
export async function markGitCredentialRevocationChecked({
  id,
  generation,
  prisma,
}: {
  id: string;
  generation: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitCredentialRevocation.updateMany({
    where: { id },
    data: {
      checkedGeneration: generation,
      lastAttemptAt: new Date(),
      lastError: null,
    },
  });
}

export async function markGitRepositoryDeletionChecked({
  id,
  generation,
  prisma,
}: {
  id: string;
  generation: string | null;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryDeletion.updateMany({
    where: { id },
    data: {
      checkedGeneration: generation,
      lastAttemptAt: new Date(),
      lastError: null,
    },
  });
}

/** 確認できなかった。**世代は書かない** (書くと終わったことになる)。 */
export async function recordGitCredentialRevocationAttempt({
  id,
  error,
  prisma,
}: {
  id: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitCredentialRevocation.updateMany({
    where: { id },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      lastError: error.slice(0, 500),
    },
  });
}

export async function recordGitRepositoryDeletionAttempt({
  id,
  error,
  prisma,
}: {
  id: string;
  error: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryDeletion.updateMany({
    where: { id },
    data: {
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
      lastError: error.slice(0, 500),
    },
  });
}

/** その id が別のリポジトリを指している。自動では決められないので人に回す。 */
export async function markGitRepositoryDeletionNeedsReview({
  id,
  reason,
  prisma,
}: {
  id: string;
  reason: string;
  prisma?: PrismaTransaction;
}) {
  const db = prisma ?? (await getDb());
  await db.gitRepositoryDeletion.updateMany({
    where: { id },
    data: {
      needsReview: true,
      lastAttemptAt: new Date(),
      lastError: reason.slice(0, 500),
    },
  });
}

/**
 * 見張る必要が無くなった控えを消す。
 *
 * 生き返らせられるのは、**まだ手元にあるバックアップで戻せる範囲だけ**。それより
 * 古い控えを持ち続けても、消し直す相手が現れることはない。渡す幅はバックアップの
 * 保持期間より長くすること。
 */
export async function pruneGitResurrectionTombstones({
  before,
  prisma,
}: {
  before: Date;
  prisma?: PrismaTransaction;
}): Promise<{ credentials: number; repositories: number }> {
  const db = prisma ?? (await getDb());

  const run = async (tx: PrismaTransaction) => {
    // **刈った線を先に進めてから消す。** 逆にすると、消した後・線を進める前に
    // 落ちたときに「控えは無いのに線は古いまま」になり、その時点の控えから
    // 戻せると誤って判断してしまう。線が先なら、落ちても「線は進んだが控えは
    // 残っている」で済む (安全側)。
    //
    // **線は前へしか動かさない。** 保持期間を延ばすと `before` は過去へ戻るが、
    // 既に消した控えは戻らない。線まで戻すと、前に断った控えをまた受け入れる。
    const watch = await tx.gitResurrectionWatch.findUnique({
      where: { id: "singleton" },
    });
    const next =
      watch?.prunedBefore && watch.prunedBefore > before
        ? watch.prunedBefore
        : before;
    await tx.gitResurrectionWatch.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", prunedBefore: next },
      update: { prunedBefore: next },
    });

    const credentials = await tx.gitCredentialRevocation.deleteMany({
      where: { baseline: false, revokedAt: { lt: before } },
    });
    const repositories = await tx.gitRepositoryDeletion.deleteMany({
      // 人の確認待ちは残す。消すと、何を見ればよかったのか分からなくなる。
      // 仕組みが入る前の行も同じ (人が片付けるまで残す)。
      where: { needsReview: false, baseline: false, deletedAt: { lt: before } },
    });
    return {
      credentials: credentials.count,
      repositories: repositories.count,
    };
  };

  // 既にトランザクションの中なら、そのまま使う。
  if (prisma) return await run(prisma);
  const client = await getDb();
  return await client.$transaction(run, { isolationLevel: "Serializable" });
}

/**
 * 入れ替え前の表に残っている控えを、新しい表へ移す。
 *
 * migration を当てている最中に古い Worker が書いた行がここに残る。放っておくと、
 * 消したのに控えの無いリポジトリになる。**確かめる仕組みが入る前のものとして**
 * 移す (消えたかどうかは分からないため)。
 *
 * 移す先が無い環境 (先に作り直した版を当てていた場合) では何もしない。
 *
 * @returns 移した件数。
 */
export async function drainLegacyGitRepositoryDeletions({
  limit = 100,
  prisma,
}: { limit?: number; prisma?: PrismaTransaction } = {}): Promise<number> {
  const db = prisma ?? (await getDb());
  let pending;
  try {
    pending = await db.gitRepositoryDeletionPending.findMany({ take: limit });
  } catch (error) {
    // 表そのものが無い。移すものは無い。
    if (isMissingTable(error)) return 0;
    throw error;
  }
  if (pending.length === 0) return 0;

  const client = await getDb();
  let moved = 0;
  for (const row of pending) {
    // **1 行ずつ、1 つのトランザクションで移す。**
    //
    // 読んでから消すまでの間に、入れ替え前の Worker が同じリポジトリ id を
    // 上書きすることがある (あちらは id を主キーに upsert する)。別々の操作に
    // すると、そこで書かれた**新しい消去の控えを消してしまう**。Forgejo からは
    // 消えているのに、追う手掛かりが無くなる。
    //
    // 消す方を先にして、**読んだときの姿と変わっていないときだけ**通す。
    // 変わっていれば 0 件になるので、その行は次の周回に回す。
    const done = await client.$transaction(async (tx) => {
      const { count } = await tx.gitRepositoryDeletionPending.deleteMany({
        where: {
          forgejoRepoId: row.forgejoRepoId,
          deletedAt: row.deletedAt,
          confirmed: row.confirmed,
          name: row.name,
          ownerUsername: row.ownerUsername,
        },
      });
      if (count !== 1) return false;
      await tx.gitRepositoryDeletion.create({
        data: {
          intentId: crypto.randomUUID(),
          forgejoRepoId: row.forgejoRepoId,
          ownerUsername: row.ownerUsername,
          name: row.name,
          deletedAt: row.deletedAt,
          needsReview: row.needsReview,
          attempts: row.attempts,
          lastAttemptAt: row.lastAttemptAt,
          lastError: row.lastError,
          // **確かめた印は引き継がない。** 前の仕組みは消す前に書いていたので、
          // 控えがあること自体は「消えた」を意味しない。
          baseline: true,
        },
      });
      return true;
    });
    if (done) moved += 1;
  }
  return moved;
}

/** 入れ替え前の表に残っている件数。0 になるまで証拠は出せない。 */
export async function countLegacyGitRepositoryDeletions({
  prisma,
}: { prisma?: PrismaTransaction } = {}): Promise<number> {
  const db = prisma ?? (await getDb());
  try {
    return await db.gitRepositoryDeletionPending.count();
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

/**
 * 入れ替え前の表が「無い」ことによる失敗か。
 *
 * **P2010 を一律で不在扱いにしない。** あれは生のクエリが失敗したことしか言わない
 * ので、接続断や権限不足まで「移すものは無い」として通してしまう。相手の表の名前が
 * 出ているものだけを不在として読む。
 */
function isMissingTable(error: unknown): boolean {
  const err = error as { code?: unknown; message?: unknown; meta?: unknown };
  const meta = err?.meta as { table?: unknown; message?: unknown } | undefined;
  if (err?.code === "P2021") {
    const table = meta?.table;
    return (
      table === undefined || String(table).includes("GitRepositoryDeletion")
    );
  }
  if (err?.code === "P2010") {
    const message = `${meta?.message ?? ""} ${err?.message ?? ""}`;
    return (
      /GitRepositoryDeletion/i.test(message) &&
      /(does not exist|undefined_table|relation .* not|42P01)/i.test(message)
    );
  }
  return false;
}
