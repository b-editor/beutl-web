import {
  attachGitRepositoryCreationId,
  auditLogActions,
  claimGitRepositoryRepair,
  claimGitRepositoryCreation,
  countGitRepositoryCreations,
  listExpiredGitRepositoryCreations,
  releaseGitRepositoryReservation,
  releaseGitRepositoryReservationFor,
  reserveGitRepositoryName,
  countGitRepositoryRepairsNeedingReview,
  markGitRepositoryRepairNeedsReview,
  renewGitRepositoryRepairLease,
  countGitRepositoryRepairs,
  createAuditLog,
  deleteGitRepositoryRepair,
  enqueueGitRepositoryRepair,
  listGitRepositoryRepairs,
  recordGitRepositoryRepairAttempt,
} from "@beutl/db";
import {
  buildCloneUrl,
  forgejoFetch,
  forgejoRequest,
  forgejoRequestOrNull,
} from "./client";
import { ForgejoError } from "./errors";
import { MAX_LFS_POINTER_BYTES, parseLfsPointer } from "./lfs";
import { encodeRepositoryPath } from "./paths";
import { GITATTRIBUTES_TEMPLATE, GITIGNORE_TEMPLATE } from "./templates";
import type {
  ForgejoBranch,
  ForgejoCommit,
  ForgejoContentsEntry,
  ForgejoRepository,
} from "./types";

/** 管理者自身のログイン名。作成中のリポジトリを預かる所有者。 */
let adminUsername: string | null = null;

async function getAdminUsername(): Promise<string> {
  if (adminUsername) return adminUsername;
  const me = await forgejoRequest<{ login: string }>("/user");
  adminUsername = me.login;
  return me.login;
}

/** Forgejo のページングの上限。 */
const MAX_PAGE_SIZE = 50;

/** UTF-8 文字列を base64 に。btoa は Latin-1 しか受け付けないため経由する。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * 1 ユーザーが持てるリポジトリ数の上限。クォータ (既定 10 GiB) の方が先に効くので
 * 実際には届かないが、Forgejo が壊れた応答を返したときに無限に回らないための箍。
 */
const MAX_REPOSITORY_PAGES = 40;

/**
 * リポジトリを全件返す。
 *
 * Forgejo は 1 ページ 50 件までしか返さない。1 ページだけ読むと 51 件目から先が
 * 黙って消え、画面の件数と合計容量も、デスクトップに返す一覧も、正しそうな顔で
 * 足りない値になる。
 */
export async function listRepositories(sudo: string) {
  const all: ForgejoRepository[] = [];

  for (let page = 1; page <= MAX_REPOSITORY_PAGES; page++) {
    const batch = await forgejoRequest<ForgejoRepository[]>("/user/repos", {
      sudo,
      searchParams: { page, limit: MAX_PAGE_SIZE },
    });
    all.push(...batch);
    // 最後のページがちょうど埋まっている場合、次が空かどうかは読むまで分からない。
    // 上限に達したときだけ 1 ページ余分に確かめる。
    if (batch.length < MAX_PAGE_SIZE) return all;
    if (page === MAX_REPOSITORY_PAGES) {
      const extra = await forgejoRequest<ForgejoRepository[]>("/user/repos", {
        sudo,
        searchParams: { page: page + 1, limit: MAX_PAGE_SIZE },
      });
      if (extra.length === 0) return all;
    }
  }

  // 打ち切った配列をそのまま返すと、呼び出し側は完全な一覧だと思って件数と
  // 合計容量を出す。足りないことに気づけないので、成功として返さない。
  throw new Error(
    `listRepositories for ${sudo} exceeded ${MAX_REPOSITORY_PAGES} pages ` +
      `(${all.length} repositories so far); refusing to return a partial list`,
  );
}

export async function getRepository(sudo: string, owner: string, name: string) {
  return await forgejoRequestOrNull<ForgejoRepository>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { sudo },
  );
}

const TEMPLATE_FILES = [
  { path: ".gitattributes", content: GITATTRIBUTES_TEMPLATE },
  { path: ".gitignore", content: GITIGNORE_TEMPLATE },
] as const;

/**
 * Beutl 用の既定ファイルのうち、まだ無いものを 1 コミットで置く。
 *
 * `create` は既にあるファイルに対して失敗する。作成直後は必ず両方無いが、
 * 辻褄合わせで呼ぶときは片方だけ入っていることがある。
 */
async function commitTemplates(
  sudo: string,
  name: string,
  branch: string,
): Promise<void> {
  const base = `/repos/${encodeURIComponent(sudo)}/${encodeURIComponent(name)}/contents`;
  const present = await Promise.all(
    TEMPLATE_FILES.map((file) =>
      forgejoRequestOrNull(`${base}/${file.path}`, { sudo }),
    ),
  );
  // 中身がずれている場合はここでは直さない。既にあるファイルを勝手に上書きすると、
  // 利用者が意図して編集した .gitattributes を壊す。
  const missing = TEMPLATE_FILES.filter((_, index) => !present[index]);
  if (missing.length === 0) return;

  await forgejoRequest(base, {
    method: "POST",
    sudo,
    body: {
      branch,
      message: "Add Beutl project defaults",
      files: missing.map((file) => ({
        operation: "create",
        path: file.path,
        content: toBase64(file.content),
      })),
    },
  });
}

/**
 * リポジトリを読み取り専用にする / 解除する。
 *
 * Forgejo の archived は push を 403 で拒み、clone は通す (16.0.2 で実測)。
 * contents API の書き込みも 423 で拒まれるので、直す前には必ず解除する。
 *
 * 代理実行 (Sudo) は使わない。これは利用者の操作ではなく、壊れた状態を広げない
 * ための処置で、当人の権限が揺れていても効く必要がある。
 */
async function setRepositoryArchived(
  owner: string,
  name: string,
  archived: boolean,
): Promise<void> {
  await forgejoRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { method: "PATCH", body: { archived } },
  );
}

/**
 * 読み取り専用にする。失敗しても投げない (呼び出し元は既に失敗の途中にいる)。
 *
 * 掛けられなかったときは控えに積む。ログだけだと、.gitattributes の無い
 * リポジトリが push を受けられる状態のまま誰にも気付かれない。
 */
/**
 * 読み取り専用にする。**控えは触らない。** 何をもって片付いたとするかは
 * 呼び出し元が決める (預かりものは譲渡し切るまで控えを外せない)。
 *
 * @returns 掛かったかどうか。
 */
async function lockRepository(
  owner: string,
  repository: Pick<ForgejoRepository, "id" | "name">,
  reason: string,
): Promise<boolean> {
  try {
    await setRepositoryArchived(owner, repository.name, true);
  } catch (error) {
    console.error(
      `${owner}/${repository.name} could not be locked; it stays queued`,
      error,
    );
    return false;
  }

  await createAuditLog({
    userId: null,
    action: auditLogActions.git.repositoryLocked,
    details:
      `${owner}/${repository.name} (id ${repository.id}) was locked because ` +
      `its Beutl defaults could not be written: ${reason}`,
    ipAddress: null,
    userAgent: null,
    port: null,
  }).catch((error) => {
    console.error("failed to record the repository lock", error);
  });
  return true;
}

/**
 * 掴んでいることを確かめて期限を延ばす。握っていなければ投げる。
 *
 * **Forgejo を触る前に必ず呼ぶ。** DB の書き込みだけを印で守っても、期限切れで
 * 引き取られた側が unarchive・commit・transfer・rename を続けられては意味が無い。
 */
async function holdRepair(forgejoRepoId: number, epoch: string): Promise<void> {
  const held = await renewGitRepositoryRepairLease({
    forgejoRepoId,
    intentId: epoch,
    leaseUntil: new Date(Date.now() + REPAIR_LEASE_MS),
  });
  if (!held) {
    throw new RepairTakenOverError(forgejoRepoId);
  }
}

/** 掴んでいた控えを他の実行に引き取られた。ここで止める。 */
export class RepairTakenOverError extends Error {
  constructor(readonly forgejoRepoId: number) {
    super(`Repository repair ${forgejoRepoId} is held by another run`);
    this.name = "RepairTakenOverError";
  }
}

/**
 * 控えを積み、**自分が握る**。
 *
 * 積むだけでは足りない。積んだ瞬間から定期実行が掴めるので、そのまま進めると
 * 前面の処理と定期実行が同じ相手を同時に譲渡でき、印を持たない削除が相手の行を
 * 消す。掴んでから進める。
 *
 * @returns 握った印。掴めなければ投げる (相手が進めているので任せる)。
 */
async function acquireRepair(
  owner: string,
  repository: ForgejoRepository,
  reason: string,
  handover?: { intendedOwner: string; intendedName: string },
): Promise<string> {
  const epoch = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + REPAIR_LEASE_MS);
  // 預かりものは控えられなければ進めない。控えが無いまま作ると、名前も分からない
  // ものが管理者の名前空間に残る。
  await queueRepair(owner, repository, reason, {
    handover,
    intentId: epoch,
    leaseUntil,
    required: handover !== undefined,
  });
  // 新しく積んだ場合はここで既に自分のもの。既にあった場合は奪えたときだけ進む。
  if (
    await renewGitRepositoryRepairLease({
      forgejoRepoId: repository.id,
      intentId: epoch,
      leaseUntil,
    })
  ) {
    return epoch;
  }
  if (
    await claimGitRepositoryRepair({
      forgejoRepoId: repository.id,
      intentId: epoch,
      notAttemptedSince: new Date(Date.now() - REPAIR_COOLDOWN_MS),
      leaseUntil,
    })
  ) {
    return epoch;
  }
  throw new RepairTakenOverError(repository.id);
}

/** 後で片付けるために控える。ここが失敗したら、もう記録は残らない。 */
async function queueRepair(
  owner: string,
  repository: Pick<ForgejoRepository, "id" | "name">,
  reason: string,
  options?: {
    handover?: { intendedOwner: string; intendedName: string };
    intentId?: string;
    leaseUntil?: Date;
    /** 控えられなければ投げる。畳める相手 (預かりもの) で使う。 */
    required?: boolean;
  },
): Promise<void> {
  const enqueued = enqueueGitRepositoryRepair({
    forgejoRepoId: repository.id,
    ownerUsername: owner,
    name: repository.name,
    ...options?.handover,
    intentId: options?.intentId,
    leaseUntil: options?.leaseUntil,
    reason,
  });
  if (options?.required) {
    await enqueued;
    return;
  }
  await enqueued.catch((error) => {
    console.error(
      `${owner}/${repository.name} (id ${repository.id}) could not be queued ` +
        "for repair; media pushed to it will not use LFS and nothing will " +
        "retry. Creating it again under the same name goes through the " +
        "repair path.",
      error,
    );
  });
}

/**
 * テンプレートを入れ直し、**入った結果が正しいことまで確かめる**。
 *
 * `commitTemplates` は既にあるファイルに触らない (利用者が意図して編集したものを
 * 壊さないため)。だから空の .gitattributes が置かれていると、何もせずに成功する。
 * そこで返ると、LFS の効かないリポジトリを push できる状態のまま残すことになる。
 *
 * 確かめられなかったら読み取り専用にしてから投げる。**直す前に解除した場合も
 * 必ず掛け直す。** 解除したまま抜けると、一度守った状態がやり直しのたびに緩む。
 */
type RepairOutcome =
  /** 既定値が揃った。 */
  | { state: "repaired" }
  /** 直せなかったので読み取り専用にした。push は通らない。 */
  | { state: "locked"; error: unknown }
  /** 直すことも止めることもできなかった。**まだ push できる。** */
  | { state: "open"; error: unknown };

/**
 * テンプレートを入れ直し、**入った結果が正しいことまで確かめる**。
 *
 * `commitTemplates` は既にあるファイルに触らない (利用者が意図して編集したものを
 * 壊さないため)。だから空の .gitattributes が置かれていると、何もせずに成功する。
 * そこで返ると、LFS の効かないリポジトリを push できる状態のまま残すことになる。
 *
 * 確かめられなかったら読み取り専用にする。**直す前に解除した場合も必ず掛け直す。**
 * 解除したまま抜けると、一度守った状態がやり直しのたびに緩む。
 *
 * **控えは触らない。** 片付いたかどうかの判断は呼び出し元がする。ここで消すと、
 * 預かりものを譲渡する前に控えが消え、管理者所有のまま追えなくなる。
 */
async function repairTemplates(
  sudo: string,
  repository: ForgejoRepository,
  epoch: string,
): Promise<RepairOutcome> {
  const name = repository.name;
  try {
    // archived のままだと contents API は 423 を返す。直すには先に外す。
    if (repository.archived) {
      await holdRepair(repository.id, epoch);
      await setRepositoryArchived(sudo, name, false);
    }
    await holdRepair(repository.id, epoch);
    await commitTemplates(sudo, name, repository.default_branch);
    await assertTemplatesAreCanonical(sudo, name);
    return { state: "repaired" };
  } catch (error) {
    // 引き取られたなら、掛け直すのも引き取った側の仕事。触らずに抜ける。
    if (error instanceof RepairTakenOverError) throw error;
    // 長いコミットの後に握りが切れていることがある。読み取り専用にするのも
    // 外部への変更なので、その直前にも確かめる。
    try {
      await holdRepair(repository.id, epoch);
    } catch (takenOver) {
      throw takenOver;
    }
    const locked = await lockRepository(
      sudo,
      repository,
      error instanceof Error ? error.message : String(error),
    );
    return locked ? { state: "locked", error } : { state: "open", error };
  }
}

/** 直せなければ投げる。利用者に返す経路で使う。 */
async function requireRepairedTemplates(
  sudo: string,
  repository: ForgejoRepository,
  epoch: string,
): Promise<void> {
  const outcome = await repairTemplates(sudo, repository, epoch);
  if (outcome.state === "repaired") return;
  throw outcome.error;
}

/**
 * Beutl の既定ファイルが両方、**中身も含めて**入っているか。
 *
 * 有無だけを見ると、空だったり途中で壊れたりした .gitattributes を「完成」と
 * みなしてしまう。それでは素材が LFS に載らず、この関数を使う意味が無い。
 */
async function hasTemplates(sudo: string, name: string): Promise<boolean> {
  const base = `/repos/${encodeURIComponent(sudo)}/${encodeURIComponent(name)}/contents`;
  const entries = await Promise.all(
    TEMPLATE_FILES.map((file) =>
      forgejoRequestOrNull<{ content?: string; encoding?: string }>(
        `${base}/${file.path}`,
        { sudo },
      ),
    ),
  );

  return entries.every((entry, index) => {
    if (!entry?.content || entry.encoding !== "base64") return false;
    return fromBase64(entry.content) === TEMPLATE_FILES[index].content;
  });
}

/**
 * 既定ファイルが揃っていなければ投げる。
 *
 * `commitTemplates` は既にあるファイルを上書きしない (利用者が意図して編集した
 * ものを壊さないため)。だから「入れ直したのに違う」ことは起こりうる。黙って
 * 成功にすると、LFS の効かないリポジトリを「作成できました」と返してしまい、
 * その後 push された数 GiB の動画が普通の git オブジェクトとして入る。
 */
async function assertTemplatesAreCanonical(sudo: string, name: string) {
  if (await hasTemplates(sudo, name)) return;
  throw new Error(
    `${sudo}/${name} does not have the expected Beutl defaults; media pushed ` +
      "to it will not use LFS, so it is left read-only. Creating the " +
      "repository again under the same name repairs it and lifts that; if " +
      "that keeps failing, check .gitattributes and .gitignore by hand.",
  );
}

/** base64 の UTF-8 文字列を戻す。atob は Latin-1 しか返さないため経由する。 */
function fromBase64(encoded: string): string {
  // Forgejo は長い内容を改行入りで返すことがある。
  const binary = atob(encoded.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 直前に試したものを飛ばす幅。重なった定期実行が同じ相手を触らないため。
 */
const REPAIR_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * 掴んでいる間の期限。譲渡まで行う場合があるので、単なる間隔では足りない。
 * 期限内は他の実行が同じ相手を触らない。
 */
const REPAIR_LEASE_MS = 10 * 60 * 1000;

/**
 * 予約を「放置された」とみなすまでの猶予。進行中の作成を掴まないための幅。
 * 作成は数秒で終わるので、これより長くかかっていれば処理は消えている。
 */
const CREATION_LEASE_MS = 10 * 60 * 1000;

/**
 * 控え 1 件を片付ける。@returns 控えを外してよいか。
 *
 * 控えには 2 種類ある。混ぜてはいけない。
 *
 *   預かりもの (intendedOwner あり) — 管理者の手元で組み立て中。**譲渡と改名まで
 *     終わって初めて片付いた**。揃っているからと途中で外すと、管理者所有のまま
 *     残り、その名前の作成を永久に塞ぐ。
 *   直し (intendedOwner なし) — 既に利用者のもの。既定値が揃うか、push できない
 *     状態 (読み取り専用) になれば片付いた。
 */
async function settleRepositoryRepair(
  entry: {
    forgejoRepoId: number;
    intendedOwner: string | null;
    intendedName: string | null;
  },
  epoch: string,
): Promise<boolean> {
  // id で引き直す。控えた名前は古くなっていることがある。
  const current = await forgejoRequestOrNull<ForgejoRepository>(
    `/repositories/${entry.forgejoRepoId}`,
  );
  // 消えている。守る相手がいない。
  if (!current) return true;

  const owner = current.owner.login;
  const admin = await getAdminUsername();
  const handover =
    entry.intendedOwner !== null && entry.intendedName !== null
      ? { owner: entry.intendedOwner, name: entry.intendedName }
      : null;

  if (handover && owner !== admin && owner !== handover.owner) {
    // 渡す先でも管理者でもない誰かが持っている。自動では決められない。
    await markGitRepositoryRepairNeedsReview({
      forgejoRepoId: entry.forgejoRepoId,
      intentId: epoch,
      reason: `held by ${owner}, expected ${admin} or ${handover.owner}`,
    });
    return false;
  }

  // 既定値が揃っていなければ先に直す。揃うまでは渡さない。
  if (!(await hasTemplates(owner, current.name))) {
    const outcome = await repairTemplates(owner, current, epoch);
    if (outcome.state !== "repaired") {
      // 直せなかった。預かりものなら渡さずに控えを残す (管理者の手元にある限り
      // 利用者は触れない)。利用者のものなら、読み取り専用にできた時点で
      // push は通らないので片付いたとみなす。
      if (handover) return false;
      return outcome.state === "locked";
    }
  }

  if (!handover) return true;

  // 預かりものを渡し切る。譲渡と改名のどちらが残っていても、ここで揃える。
  // 渡し終わったら予約も外す。ここまでは名前を押さえたままにする。
  if (owner === admin) {
    await handOver(
      admin,
      current.name,
      handover.owner,
      handover.name,
      entry.forgejoRepoId,
      epoch,
    );
    await releaseGitRepositoryReservationFor({
      ownerUsername: handover.owner,
      name: handover.name,
    }).catch(() => undefined);
    return true;
  }
  // 譲渡は済んでいて改名だけが残っている。
  if (current.name !== handover.name) {
    await holdRepair(entry.forgejoRepoId, epoch);
    try {
      await forgejoRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(current.name)}`,
        { method: "PATCH", body: { name: handover.name } },
      );
    } catch (error) {
      // 本来の名前が既に埋まっている。何度やり直しても通らないので、
      // 15 分ごとに回し続けずに人へ回す。中身は揃っていて所有者も正しいので、
      // 実害は「預かり名のままになっている」ことだけ。
      if (
        error instanceof ForgejoError &&
        (error.isConflict || error.status === 422)
      ) {
        await markGitRepositoryRepairNeedsReview({
          forgejoRepoId: entry.forgejoRepoId,
          intentId: epoch,
          reason: `cannot rename to ${handover.name}: ${error.body.slice(0, 200)}`,
        });
        return false;
      }
      throw error;
    }
  }
  await releaseGitRepositoryReservationFor({
    ownerUsername: handover.owner,
    name: handover.name,
  }).catch(() => undefined);
  return true;
}

/**
 * 放置された予約を片付ける。定期実行から呼ぶ。
 *
 * 201 の直後に処理が消えると、管理者の名前空間に預かりものが残り、リポジトリ id は
 * 誰も知らない。予約には**先に決めた預かり名**が入っているので、そこから引き当てて
 * 控えに載せ替える。載せ替えれば、あとは通常の片付けが渡し切る。
 *
 * 進行中のものを掴まないよう、しばらく前の予約だけを見る。
 */
async function reconcileStaleCreations(limit: number): Promise<void> {
  const stale = await listExpiredGitRepositoryCreations({ limit });
  const admin = await getAdminUsername();

  for (const entry of stale) {
    // 掴む。期限内のもの (前面が進めているもの) は返ってこない。
    const epoch = crypto.randomUUID();
    if (
      !(await claimGitRepositoryCreation({
        id: entry.id,
        intentId: epoch,
        leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
      }))
    ) {
      continue;
    }

    try {
      // id が分かっていればそれで、分からなければ預かり名で引く。
      const holding = entry.forgejoRepoId
        ? await forgejoRequestOrNull<ForgejoRepository>(
            `/repositories/${entry.forgejoRepoId}`,
          )
        : await getRepository(admin, admin, entry.holdingName);

      if (holding && holding.owner.login === admin) {
        // 預かったまま残っている。控えに載せ替える。**予約は外さない。**
        // ここで外すと、渡し終わる前に同じ名前を再び予約でき、2 つの預かりものが
        // 同じ相手に渡る。外すのは渡し切った側 (settleRepositoryRepair)。
        await queueRepair(admin, holding, "abandoned before hand-over", {
          handover: {
            intendedOwner: entry.ownerUsername,
            intendedName: entry.name,
          },
          required: true,
        });
        continue;
      }

      // 相手が居ない = 作られなかった。予約は不要。
      await releaseGitRepositoryReservation({ id: entry.id });
    } catch (error) {
      // 分からないまま外さない。次の周回でやり直す。
      console.error(
        `could not reconcile the reservation of ${entry.ownerUsername}/${entry.name}`,
        error,
      );
    }
  }
}

/**
 * 入れ切れなかったテンプレートと、渡し切れなかった預かりものを片付ける。
 * 定期実行から呼ぶ。
 *
 * 控えてあるのは **Forgejo のリポジトリ id**。名前で引き直すと、改名で空いた名前を
 * 取った別のリポジトリを止めてしまう。id で引き、そのとき返る名前に対して操作する。
 *
 * @returns 片付いた件数、まだ残っている件数、人の確認待ちの件数。
 */
export async function retryGitRepositoryRepairs({
  limit = 20,
}: { limit?: number } = {}): Promise<{
  fixed: number;
  pending: number;
  review: number;
}> {
  // **先に予約を片付ける。** 控えに載せ替えたものを同じ周回で渡し切るため。
  // 後回しにすると、載せ替えてから渡すまでの間に同じ名前を再び予約できる。
  await reconcileStaleCreations(limit);

  const cutoff = new Date(Date.now() - REPAIR_COOLDOWN_MS);
  const queued = await listGitRepositoryRepairs({
    notAttemptedSince: cutoff,
    limit,
  });
  let fixed = 0;

  for (const entry of queued) {
    // 掴むときに印を差し替える。前の持ち主はこれで以後 1 件も更新できない。
    const epoch = crypto.randomUUID();
    if (
      !(await claimGitRepositoryRepair({
        forgejoRepoId: entry.forgejoRepoId,
        intentId: epoch,
        notAttemptedSince: cutoff,
        leaseUntil: new Date(Date.now() + REPAIR_LEASE_MS),
      }))
    ) {
      continue;
    }

    try {
      if (await settleRepositoryRepair(entry, epoch)) {
        // 自分が握っている行だけを外す。引き取られていたら消えない。
        if (
          await deleteGitRepositoryRepair({
            forgejoRepoId: entry.forgejoRepoId,
            intentId: epoch,
          })
        ) {
          fixed += 1;
        }
      }
    } catch (error) {
      await recordGitRepositoryRepairAttempt({
        forgejoRepoId: entry.forgejoRepoId,
        intentId: epoch,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }

  // 1 回分ではなく残っている総数。21 件目以降が残っていても 0 と報告しない。
  return {
    fixed,
    pending:
      (await countGitRepositoryRepairs()) +
      (await countGitRepositoryCreations()),
    review: await countGitRepositoryRepairsNeedingReview(),
  };
}

/**
 * リポジトリを作り、Beutl 用の .gitattributes / .gitignore を最初のコミットに入れる。
 * .gitattributes が無いと素材が LFS に載らないので、作成と同時に置くのが要点。
 */
/**
 * 預かったままのリポジトリを畳む。
 *
 * **id で今の姿を確かめてから消す。** 名前で消すと、その名前が別のものに
 * 渡っていた場合に巻き添えにする。消せなかったときは控えを残す。ログだけにすると、
 * 管理者所有のまま誰にも知られずに残り、同じ名前の作成を塞ぎ続ける。
 */
async function discardHolding(
  admin: string,
  repository: ForgejoRepository,
  epoch?: string,
): Promise<boolean> {
  try {
    // **消す直前にも握りを確かめる。** 期限切れで引き取られた後に消しにいくと、
    // 引き取った側が渡そうとしているものを壊す。
    if (epoch) await holdRepair(repository.id, epoch);
    const current = await forgejoRequestOrNull<ForgejoRepository>(
      `/repositories/${repository.id}`,
    );
    if (!current) {
      // 既に無い。控えも要らない。
      await deleteGitRepositoryRepair({
        forgejoRepoId: repository.id,
        intentId: epoch,
      }).catch(() => undefined);
      return true;
    }
    if (current.owner.login !== admin) {
      // 既に渡っている。畳む相手ではない。
      return false;
    }
    // **消す直前にもう一度。** 上の照会にかかる間に期限が切れることがある
    // (このクライアントに明示的な待ち時間の上限は無い)。確かめ直さないと、
    // 引き取った側が渡そうとしているものを消せてしまう。
    if (epoch) await holdRepair(repository.id, epoch);
    await forgejoRequest(
      `/repos/${encodeURIComponent(admin)}/${encodeURIComponent(current.name)}`,
      { method: "DELETE", responseType: "none" },
    );
    await deleteGitRepositoryRepair({
      forgejoRepoId: repository.id,
      intentId: epoch,
    }).catch(() => undefined);
    return true;
  } catch (error) {
    // 引き取られていたら、後始末も引き取った側の仕事。触らない。
    if (error instanceof RepairTakenOverError) return false;
    // 控えは残す。次の定期実行が id で引き直して片付ける。
    console.error(
      `could not discard the holding repository ${admin}/${repository.name}; ` +
        "it stays queued",
      error,
    );
    return false;
  }
}

/** 譲渡して、最終的な名前に直す。@returns 渡し終えたリポジトリ。 */
async function handOver(
  admin: string,
  holdingName: string,
  intendedOwner: string,
  intendedName: string,
  repoId: number,
  epoch: string,
): Promise<ForgejoRepository> {
  // ここで初めて利用者のものになる。既定値は入り終わっている。
  // id は変わらない (16.0.2 で実測)。
  await holdRepair(repoId, epoch);
  const transferred = await forgejoRequest<ForgejoRepository>(
    `/repos/${encodeURIComponent(admin)}/${encodeURIComponent(holdingName)}/transfer`,
    { method: "POST", body: { new_owner: intendedOwner } },
  );
  if (transferred.name === intendedName) return transferred;
  await holdRepair(repoId, epoch);
  // 預かり名は毎回違うので、渡した後に本来の名前へ直す。名前が空いていることは
  // 作成の前に確かめてある。
  return await forgejoRequest<ForgejoRepository>(
    `/repos/${encodeURIComponent(intendedOwner)}/${encodeURIComponent(transferred.name)}`,
    { method: "PATCH", body: { name: intendedName } },
  );
}

/**
 * リポジトリを作り、Beutl 用の .gitattributes / .gitignore を最初のコミットに入れる。
 *
 * **利用者の名前空間には作らない。** 管理者の名前空間で作り、既定値を入れ切って
 * から譲渡する。利用者は譲渡の瞬間まで見ることも触ることもできないので、
 * .gitattributes が入る前に push される隙間が無い。
 *
 * 隙間を残すと、そこへ入った数 GiB の動画は普通の git オブジェクトとして履歴に
 * 残る。後から .gitattributes を足しても、既に入った履歴は LFS に移らない。
 *
 * 預かる名前は毎回違うものにする。最終的な名前で預かると、同じ名前を別の利用者が
 * 同時に作ったときに、どちらの預かりものか区別できず、他人のものを渡してしまう。
 */
export async function createRepository(
  sudo: string,
  {
    name,
    description = "",
  }: {
    name: string;
    description?: string;
  },
) {
  // 先に不在を確かめる。作成 API が 502 や 504 で落ちたとき、衝突だったのか
  // 応答を落としただけなのかは区別できない。
  const conflicting = await getRepository(sudo, sudo, name);
  if (conflicting) {
    // テンプレートが揃っていれば普通の名前衝突。
    if (await hasTemplates(sudo, name)) {
      throw new ForgejoError(
        409,
        "POST",
        "/user/repos",
        `repository ${sudo}/${name} already exists`,
      );
    }

    // 揃っていないなら、以前の作成が途中で終わったもの。ここで 409 にすると
    // 二度と直せる経路が無くなり、LFS の効かないリポジトリに push され続ける。
    // やり直しをそのまま修復として扱う。**直せたときだけ** push できる状態に戻る。
    // 直す前に握る。掴めなければ定期実行が触っているので、やり直させる。
    const epoch = await acquireRepair(sudo, conflicting, "repair requested");
    await requireRepairedTemplates(sudo, conflicting, epoch);
    // 直った。控えに残す理由が無い。
    await deleteGitRepositoryRepair({
      forgejoRepoId: conflicting.id,
      intentId: epoch,
    }).catch(() => undefined);
    return conflicting;
  }

  const admin = await getAdminUsername();
  // この 1 回の作成にしか使わない名前。応答を落としても、この名前で引ければ
  // 自分が作ったものだと言い切れる。
  const holdingName = `beutl-holding-${crypto.randomUUID()}`;

  // **Forgejo を触る前に予約する。** 上の不在確認だけでは、同じ名前の作成が
  // 同時に来たときに両方が通り、両方が譲渡され、片方だけ改名に失敗して預かり名の
  // まま利用者の手に残る。名前が埋まっていれば、ここで弾かれる。
  // 預かり名も一緒に控えるので、201 の直後に落ちても相手を引き当てられる。
  const reservationEpoch = crypto.randomUUID();
  const reservation = await reserveGitRepositoryName({
    ownerUsername: sudo,
    name,
    holdingName,
    intentId: reservationEpoch,
    leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
  });

  let holding: ForgejoRepository;
  try {
    // Sudo を付けない = 管理者自身の名前空間に作る。
    holding = await forgejoRequest<ForgejoRepository>("/user/repos", {
      method: "POST",
      body: {
        name: holdingName,
        description,
        // プライベート専用で運用する。Forgejo 側も FORCE_PRIVATE で固定している。
        private: true,
        auto_init: true,
        default_branch: "main",
      },
    });
  } catch (error) {
    // 502/504 など。作られたのか作られていないのかが分からない。**自分の名前で**
    // 引き直す。他人の預かりものを拾うことはない。
    // 「無い」と「確かめられなかった」を混ぜない。混ぜると、POST は通っていて
    // 確認だけが落ちた場合に、追えない預かりものを残したまま予約まで外してしまう。
    let existing: ForgejoRepository | null;
    try {
      existing = await getRepository(admin, admin, holdingName);
    } catch {
      // 分からない。予約は残す。期限が切れたら定期実行が引き取って判断する。
      throw error;
    }
    if (!existing) {
      // 作られていないと確かめられた。予約を外してよい。
      await releaseGitRepositoryReservation({ id: reservation }).catch(
        () => undefined,
      );
      throw error;
    }
    holding = existing;
  }

  // 応答で初めて分かる id を予約に紐付ける。これで、この先どこで落ちても
  // 定期実行が id で引き直せる。
  await attachGitRepositoryCreationId({
    id: reservation,
    forgejoRepoId: holding.id,
  }).catch((error) => {
    console.error(
      `could not attach ${holding.id} to the reservation of ${sudo}/${name}`,
      error,
    );
  });

  // 落ちても追えるように控える。渡す先と最終的な名前も一緒に控えないと、
  // 譲渡の前に落ちた預かりものが「揃っているから片付いた」と見なされ、
  // 管理者所有のまま残って同じ名前を塞ぎ続ける。
  let epoch: string;
  try {
    epoch = await acquireRepair(
      admin,
      holding,
      "held for setup; not transferred yet",
      { intendedOwner: sudo, intendedName: name },
    );
  } catch (error) {
    // 控えを作れなかった (DB に書けなかった)。このまま抜けると、名前も分からない
    // 預かりものが管理者の名前空間に残り、誰も片付けられない。畳んでから投げる。
    // 引き取られていた場合だけは、相手のものなので触らない。
    if (!(error instanceof RepairTakenOverError)) {
      // **畳めたときだけ**予約を外す。消せていないのに外すと、追えない
      // 預かりものが残ったまま同じ名前を再び予約できる。
      if (await discardHolding(admin, holding)) {
        await releaseGitRepositoryReservation({ id: reservation }).catch(
          () => undefined,
        );
      }
    }
    throw error;
  }

  try {
    await holdRepair(holding.id, epoch);
    await commitTemplates(admin, holdingName, holding.default_branch);
    await assertTemplatesAreCanonical(admin, holdingName);
  } catch (error) {
    // 引き取られたなら、後始末も相手の仕事。**決して消さない。**
    if (error instanceof RepairTakenOverError) throw error;
    // 利用者はまだ触れない。自分で作ったものなので畳んでやり直させる。
    if (await discardHolding(admin, holding, epoch)) {
      await releaseGitRepositoryReservation({ id: reservation }).catch(
        () => undefined,
      );
    }
    throw error;
  }

  try {
    const handed = await handOver(
      admin,
      holdingName,
      sudo,
      name,
      holding.id,
      epoch,
    );
    await deleteGitRepositoryRepair({
      forgejoRepoId: holding.id,
      intentId: epoch,
    }).catch(() => undefined);
    await releaseGitRepositoryReservation({ id: reservation }).catch(
      () => undefined,
    );
    return handed;
  } catch (error) {
    if (error instanceof RepairTakenOverError) throw error;
    if (await discardHolding(admin, holding, epoch)) {
      await releaseGitRepositoryReservation({ id: reservation }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

/**
 * 名前を変える。
 *
 * **作成と同じ予約を通す。** 直接 PATCH すると、作成が `proj` を押さえて預かり
 * ものを組み立てている最中に別のリポジトリを `proj` に改名でき、作成側の最後の
 * 改名が衝突する。名前を触る操作はすべて同じ場所で直列にする。
 */
export async function renameRepository(
  sudo: string,
  owner: string,
  name: string,
  newName: string,
) {
  const reservation = await reserveGitRepositoryName({
    ownerUsername: owner,
    name: newName,
    // 改名では預かりものを作らない。一意制約のために名前そのものを入れる。
    holdingName: `beutl-rename-${crypto.randomUUID()}`,
    intentId: crypto.randomUUID(),
    leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
  });
  try {
    return await forgejoRequest<ForgejoRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        sudo,
        body: { name: newName },
      },
    );
  } finally {
    // 成否によらず外す。名前は Forgejo 側で決着している。
    await releaseGitRepositoryReservation({ id: reservation }).catch(
      () => undefined,
    );
  }
}

export async function updateRepositoryDescription(
  sudo: string,
  owner: string,
  name: string,
  description: string,
) {
  return await forgejoRequest<ForgejoRepository>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      sudo,
      body: { description },
    },
  );
}

export async function deleteRepository(
  sudo: string,
  owner: string,
  name: string,
) {
  await forgejoRequest(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    { method: "DELETE", sudo, responseType: "none" },
  );
}

/**
 * ディレクトリの中身、または単一ファイルのメタ情報。
 * パスが空ならリポジトリ直下。
 */
export async function listContents(
  sudo: string,
  owner: string,
  name: string,
  path = "",
  ref?: string,
) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents`;
  const url = path ? `${base}/${encodeRepositoryPath(path)}` : base;
  const result = await forgejoRequestOrNull<
    ForgejoContentsEntry[] | ForgejoContentsEntry
  >(url, { sudo, searchParams: { ref } });

  if (result === null) return null;
  return Array.isArray(result) ? result : [result];
}

/**
 * ファイルの中身をそのまま取る。LFS 管理下ならポインタが返る
 * (実体が要るときは fetchMedia の方を使う)。
 *
 * maxBytes を超えるものは読まずに null を返す。LFS に載せていない巨大なバイナリが
 * あると、表示するかどうかを判断する前にメモリへ載ってしまうため。
 */
/**
 * `maxBytes` を超えていたときの戻り値。
 * 「存在しない」を表す null と区別できないと、呼び出し側は 404 を返すしかなくなる。
 */
export const FILE_TOO_LARGE = Symbol("FILE_TOO_LARGE");

/** 上限を超えない範囲だけ読む。超えたら残りを捨てて打ち切る。 */
async function readUpTo(
  response: Response,
  maxBytes: number,
): Promise<string | typeof FILE_TOO_LARGE> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return FILE_TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export async function getRawFile(
  sudo: string,
  owner: string,
  name: string,
  path: string,
  ref?: string,
  { maxBytes }: { maxBytes?: number } = {},
): Promise<string | null | typeof FILE_TOO_LARGE> {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const response = await forgejoFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${encodeRepositoryPath(path)}${query}`,
    { sudo },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new ForgejoError(
      response.status,
      "GET",
      `/repos/${owner}/${name}/raw/${path}`,
      await response.text().catch(() => ""),
    );
  }

  if (maxBytes === undefined) {
    return await response.text();
  }

  const declared = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    // 読まずに捨てる。body を放置すると接続が滞留する。
    await response.body?.cancel();
    return FILE_TOO_LARGE;
  }
  // Content-Length が無いと上の判定は素通りする。ヘッダを信じきらず、読みながら
  // 打ち切る (無ければ 0 と評価され、どんな大きさでも通ってしまう)。
  return await readUpTo(response, maxBytes);
}

/**
 * 一覧に出すファイルの実サイズを解決する。
 *
 * contents API が返す size は、LFS 管理下のファイルではポインタ自身のバイト数
 * (百数十バイト) になる。動画を「133 Bytes」と表示してしまうため、ポインタで
 * ありうる小さいファイルだけ中身を読んで実サイズに置き換える。
 *
 * 読みに行くのは candidateLimit 件まで。それを超えた分は誤った数字を出すより
 * 黙る方を選び、size を undefined にする (呼び出し側で非表示にする)。
 */
export async function resolveContentSizes(
  sudo: string,
  owner: string,
  name: string,
  entries: ForgejoContentsEntry[],
  { ref, candidateLimit = 30 }: { ref?: string; candidateLimit?: number } = {},
): Promise<Map<string, number | undefined>> {
  const sizes = new Map<string, number | undefined>();
  const candidates: ForgejoContentsEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== "file") continue;
    // ポインタは仕様上 1KiB を超えない。これより大きければ実体そのもの。
    if (entry.size > MAX_LFS_POINTER_BYTES) {
      sizes.set(entry.path, entry.size);
    } else {
      candidates.push(entry);
    }
  }

  const resolvable = candidates.slice(0, candidateLimit);
  for (const entry of candidates.slice(candidateLimit)) {
    sizes.set(entry.path, undefined);
  }

  const contents = await Promise.all(
    resolvable.map((entry) =>
      getRawFile(sudo, owner, name, entry.path, ref, {
        maxBytes: MAX_LFS_POINTER_BYTES,
      }).catch(() => null),
    ),
  );

  resolvable.forEach((entry, index) => {
    const content = contents[index];
    // ここに来る候補はポインタの上限以下なので FILE_TOO_LARGE は出ないが、
    // 出たとしてもポインタではないので実体の大きさをそのまま使う。
    const pointer =
      typeof content === "string" ? parseLfsPointer(content) : null;
    sizes.set(entry.path, pointer ? pointer.size : entry.size);
  });

  return sizes;
}

/**
 * ファイルの実体を取る。LFS 管理下のファイルはここで実データが返る。
 * 読み切らずに中継できるよう Response のまま返す。
 */
export async function fetchMedia(
  sudo: string,
  owner: string,
  name: string,
  path: string,
  ref?: string,
  { forwardHeaders }: { forwardHeaders?: Record<string, string | null> } = {},
) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  return await forgejoFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/media/${encodeRepositoryPath(path)}${query}`,
    { sudo, forwardHeaders },
  );
}

export async function listCommits(
  sudo: string,
  owner: string,
  name: string,
  {
    path,
    page = 1,
    limit = 30,
  }: { path?: string; page?: number; limit?: number } = {},
) {
  const commits = await forgejoRequestOrNull<ForgejoCommit[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits`,
    { sudo, searchParams: { path, page, limit } },
  );
  // 空のリポジトリでは 404 が返る。履歴なしとして扱う。
  return commits ?? [];
}

export async function listBranches(sudo: string, owner: string, name: string) {
  const branches = await forgejoRequestOrNull<ForgejoBranch[]>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/branches`,
    { sudo },
  );
  return branches ?? [];
}

export { buildCloneUrl };
