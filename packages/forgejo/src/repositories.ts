import {
  attachGitRepositoryCreationId,
  auditLogActions,
  GitRepositoryNameTakenError,
  claimGitRepositoryRepair,
  claimGitRepositoryCreation,
  clearGitRepositoryCreationMissing,
  GitRepositoryOperation,
  normalizeRepositoryName,
  releaseGitRepositoryReservationsByIntent,
  markGitRepositoryCreationMissing,
  countGitRepositoryCreations,
  listExpiredGitRepositoryCreations,
  releaseGitRepositoryReservation,
  renewGitRepositoryCreationLease,
  reserveGitRepositoryName,
  countGitRepositoryRepairsNeedingReview,
  findGitRepositoryRepair,
  findGitRepositoryReservationByName,
  getGitReconcileCursor,
  setGitReconcileCursor,
  markGitRepositoryRepairLocked,
  markGitRepositoryRepairNeedsReview,
  renewGitRepositoryRepairLease,
  countGitRepositoryRepairs,
  createAuditLog,
  deleteGitRepositoryRepair,
  enqueueGitRepositoryRepair,
  listGitRepositoryRepairs,
  confirmGitRepositoryDeletion,
  dropGitRepositoryDeletion,
  recordGitRepositoryDeletion,
  recordGitRepositoryRepairAttempt,
} from "@beutl/db";
import {
  buildCloneUrl,
  forgejoFetch,
  forgejoRequest,
  forgejoRequestOrNull,
} from "./client";
import { ForgejoError, isDecided } from "./errors";
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
  /** 補償そのものが曖昧に終わったら、ここに印を立てる。 */
  pending?: { value: boolean },
): Promise<boolean> {
  try {
    await setRepositoryArchived(owner, repository.name, true);
  } catch (error) {
    // **補償が曖昧に終わることもある。** 待ち時間切れや 5xx では、読み取り専用が
    // 後から掛かることがある。掛からなかったものとして名前を手放すと、遅れて
    // 着地した archive が、その名前を取った別のリポジトリを止めてしまう。
    if (pending && !isDecided(error)) pending.value = true;
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

/** 変更を送る。結果が分からない失敗だったら印を立てて投げ直す。 */
async function sendMutation<T>(
  pending: { value: boolean },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isDecided(error)) pending.value = true;
    throw error;
  }
}

/**
 * 直しの途中で送った変更が、届いたかどうか分からないまま終わった。
 *
 * **控えも名前の予約も残す。** 補償の読み取り専用が通っていても、遅れて着地した
 * unarchive や commit がその後に効けば、既定値の入っていないリポジトリがまた
 * 書き込み可能になる。片付いたことにしてよいのは、送ったものが確定した後だけ。
 */
export class RepairPendingError extends Error {
  constructor(
    readonly forgejoRepoId: number,
    readonly reason: unknown,
  ) {
    super(
      `repair of repository ${forgejoRepoId} left a mutation in an unknown ` +
        `state: ${reason instanceof Error ? reason.message : String(reason)}`,
    );
    this.name = "RepairPendingError";
  }
}

/** 掴んでいた控えを他の実行に引き取られた。ここで止める。 */
export class RepairTakenOverError extends Error {
  constructor(readonly forgejoRepoId: number) {
    super(`Repository repair ${forgejoRepoId} is held by another run`);
    this.name = "RepairTakenOverError";
  }
}

/** 送ろうとした名前が、もうこのリポジトリを指していない。 */
export class RepositoryMovedError extends Error {
  constructor(
    readonly forgejoRepoId: number,
    expected: string,
  ) {
    super(`repository ${forgejoRepoId} is no longer ${expected}`);
    this.name = "RepositoryMovedError";
  }
}

/**
 * 直しの間だけ名前を押さえるときの預かり名。
 *
 * この接頭辞の予約は**名前を押さえているだけ**で、やり残した作業を表さない
 * (作業そのものは GitRepositoryRepair 側にリポジトリ id で積んである)。
 * だから放置されていても、後始末は名前を手放すだけでよい。
 */
const REPAIR_HOLDING_PREFIX = "beutl-repair-";

/**
 * これから触る名前を押さえる。
 *
 * **id を確かめるだけでは足りない。** 確認から送信までの 1 往復は開いたままで、
 * その間に相手が改名され、空いた名前を別のリポジトリが取れる。予約を取れば、
 * 作成・改名・削除はどれも同じ一意キー (所有者, 小文字化した名前) を取りにいくので、
 * 押さえている間は誰もその名前を動かせない。Forgejo を触るのはこちらの経路だけ
 * なので、これで直列化できる。
 *
 * @param adoptableId 引き継いでよい予約の id。控えが控えている予約を指す。
 * @returns 予約の id。取れなければ null (今その名前を誰かが動かしている)。
 */
async function holdName(
  owner: string,
  name: string,
  forgejoRepoId: number,
  epoch: string,
  adoptableId?: string | null,
): Promise<string | null> {
  let reservation: string;
  try {
    reservation = await reserveGitRepositoryName({
      ownerUsername: owner,
      name,
      holdingName: `${REPAIR_HOLDING_PREFIX}${crypto.randomUUID()}`,
      intentId: epoch,
      leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
    });
  } catch (error) {
    if (error instanceof GitRepositoryNameTakenError) {
      return await adoptName(owner, name, forgejoRepoId, epoch, adoptableId);
    }
    throw error;
  }
  // **相手を控えられなければ追跡できない。** 書けないまま残すと、取り残された
  // ときに何を押さえていたのか分からなくなる。握り潰さず、外して投げる。
  if (
    !(await attachGitRepositoryCreationId({
      id: reservation,
      intentId: epoch,
      forgejoRepoId,
    }))
  ) {
    await releaseGitRepositoryReservation({
      id: reservation,
      intentId: epoch,
    }).catch(() => undefined);
    throw new RepairTakenOverError(forgejoRepoId);
  }
  return reservation;
}

/**
 * 取り残した予約を引き継ぐ。**取り直しはしない。**
 *
 * 待ち時間切れや 5xx では名前を手放さない (手放すと、遅れて着地した処理が別の
 * リポジトリに当たる)。その代わり、次の周回は同じ名前をもう予約できない。
 * 引き継げないと、控えと予約が互いを待って永久に止まる:
 * 予約の片付けは「控えがあるなら控え側の仕事」として触らず、控え側は名前を
 * 取れずに何もせず帰る、という状態が毎回繰り返される。
 *
 * 引き継ぐのは、**自分たちの取り残しだと証拠から言い切れるものだけ**。
 *
 *   (a) 控えがその予約 id を控えている (預かりものを渡し切る途中で落ちた)
 *   (b) 直しの預かり名で、同じリポジトリ id を指している (直しの途中で落ちた)
 *
 * どちらでもなければ、今まさに誰かが動かしている名前なので触らない。加えて
 * **期限が切れているときだけ**引き継ぐ (`claimGitRepositoryCreation` がそう
 * 条件付ける)。動いている処理から横取りはしない。
 */
async function adoptName(
  owner: string,
  name: string,
  forgejoRepoId: number,
  epoch: string,
  adoptableId?: string | null,
): Promise<string | null> {
  const existing = await findGitRepositoryReservationByName({
    ownerUsername: owner,
    name,
  });
  // 見に行くまでの間に外れた。取り直しはここではしない (次の周回で取る)。
  if (!existing) return null;

  const ours =
    (adoptableId != null && existing.id === adoptableId) ||
    (existing.holdingName.startsWith(REPAIR_HOLDING_PREFIX) &&
      existing.forgejoRepoId === forgejoRepoId);
  if (!ours) return null;

  if (
    !(await claimGitRepositoryCreation({
      id: existing.id,
      intentId: epoch,
      leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
    }))
  ) {
    // まだ期限内。前の持ち主が動いている。
    return null;
  }
  // 引き継いだ後も相手を控えておく。控えられなければ追跡できないので、
  // 新しく取ったときと同じく握り潰さずに外して投げる。
  if (
    !(await attachGitRepositoryCreationId({
      id: existing.id,
      intentId: epoch,
      forgejoRepoId,
    }))
  ) {
    await releaseGitRepositoryReservation({
      id: existing.id,
      intentId: epoch,
    }).catch(() => undefined);
    throw new RepairTakenOverError(forgejoRepoId);
  }
  return existing.id;
}

/**
 * 押さえた名前の期限を延ばす。握っていなければ投げる。
 *
 * **各 mutation の前に呼ぶ。** 1 回取ったきりの期限 (10 分) は、直しの複数の
 * API 呼び出し (最大 2 分 × 数回) で超えうる。超えると定期実行が期限切れと
 * 読んで名前を解放し、実行中の直しと並行して同じ名前を作れる。
 */
async function renewName(id: string, epoch: string): Promise<void> {
  const held = await renewGitRepositoryCreationLease({
    id,
    intentId: epoch,
    leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
  });
  if (!held) throw new RepairTakenOverError(-1);
}

/** 押さえた名前を手放す。決着の有無によらず、握っていた分だけ外す。 */
async function releaseName(id: string, epoch: string): Promise<void> {
  await releaseGitRepositoryReservation({ id, intentId: epoch }).catch(
    () => undefined,
  );
}

/**
 * **名前で送る直前に、その名前がまだこの id を指しているかを確かめる。**
 *
 * 直しは全て名前で送るしかない (contents API も archived の PATCH も id では
 * 送れない)。id から名前を引いてから送るまでの間に、そのリポジトリが改名され、
 * 空いた名前を別のリポジトリが取ることがある。確かめずに送ると、無関係な
 * リポジトリに .gitattributes を書き込み、読み取り専用にし、そのうえで元の
 * リポジトリの直しを「片付いた」として控えから外してしまう。
 *
 * 握り (holdRepair) では防げない。あれが見ているのは「この処理がまだ担当か」で
 * あって、「その名前がまだこの相手か」ではない。
 *
 * **これだけでは足りない。** 確認から送信までの 1 往復は開いたままなので、
 * 名前そのものを押さえたうえで (holdName)、押さえた後にこれで確かめる。
 * 押さえる前の姿を確かめても、押さえた時点の姿とは限らない。
 */
async function assertStillNamed(
  owner: string,
  repository: Pick<ForgejoRepository, "id" | "name">,
): Promise<void> {
  const current = await forgejoRequestOrNull<ForgejoRepository>(
    `/repositories/${repository.id}`,
    { timeoutMs: HELD_REQUEST_TIMEOUT_MS },
  );
  if (
    !current ||
    current.owner.login.toLowerCase() !== owner.toLowerCase() ||
    current.name !== repository.name
  ) {
    throw new RepositoryMovedError(
      repository.id,
      `${owner}/${repository.name}`,
    );
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
  reservationId?: string,
): Promise<string> {
  const epoch = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + REPAIR_LEASE_MS);
  // 預かりものは控えられなければ進めない。控えが無いまま作ると、名前も分からない
  // ものが管理者の名前空間に残る。
  await queueRepair(owner, repository, reason, {
    handover,
    reservationId,
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

/**
 * 予約を握っていることを確かめて期限を延ばす。握っていなければ投げる。
 *
 * **Forgejo を触る前に呼ぶ。** DB の書き込みだけを印で守っても、期限切れで
 * 引き取られた側が作成や譲渡を続けられては意味が無い。
 */
async function holdReservation(id: string, epoch: string): Promise<void> {
  const held = await renewGitRepositoryCreationLease({
    id,
    intentId: epoch,
    leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
  });
  if (!held) throw new RepairTakenOverError(-1);
}

/** 後で片付けるために控える。ここが失敗したら、もう記録は残らない。 */
async function queueRepair(
  owner: string,
  repository: Pick<ForgejoRepository, "id" | "name">,
  reason: string,
  options?: {
    handover?: { intendedOwner: string; intendedName: string };
    reservationId?: string;
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
    reservationId: options?.reservationId,
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
  /**
   * 直せなかったので読み取り専用にした。push は通らない。
   *
   * `pending` は「送った変更のどれかが、届いたか分からないまま終わった」印。
   * 立っている間は片付いたと見なせない (読み取り専用にできていても、遅れて
   * 着地した unarchive がそれを外しうる)。
   */
  | { state: "locked"; error: unknown; pending: boolean }
  /** 直すことも止めることもできなかった。**まだ push できる。** */
  | { state: "open"; error: unknown; pending: boolean };

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
  /** 押さえている名前の予約。各 mutation の前に延ばす (期限は 10 分で、
   * 複数の API 呼び出しで超えうる)。無ければ延ばさない (呼び出し元が別途
   * 管理している場合)。 */
  nameHold?: { id: string; epoch: string },
): Promise<RepairOutcome> {
  const name = repository.name;
  const renewNameHold = () =>
    nameHold ? renewName(nameHold.id, nameHold.epoch) : Promise.resolve();
  // 外へ送った変更のうち、届いたか分からないものがあるか。**補償の読み取り専用が
  // 通っても、これが立っていれば片付いたことにはできない。**
  const pending = { value: false };
  try {
    // archived のままだと contents API は 423 を返す。直すには先に外す。
    if (repository.archived) {
      await renewNameHold();
      await holdRepair(repository.id, epoch);
      await assertStillNamed(sudo, repository);
      await sendMutation(pending, () =>
        setRepositoryArchived(sudo, name, false),
      );
    }
    await renewNameHold();
    await holdRepair(repository.id, epoch);
    await assertStillNamed(sudo, repository);
    await sendMutation(pending, () =>
      commitTemplates(sudo, name, repository.default_branch),
    );
    // 照合も名前で読む。読む直前にも確かめないと、入れ替わった別のリポジトリの
    // 中身を見て「揃っている」と結論しうる。
    await renewNameHold();
    await assertStillNamed(sudo, repository);
    await assertTemplatesAreCanonical(sudo, name);
    return { state: "repaired" };
  } catch (error) {
    // 引き取られたなら、掛け直すのも引き取った側の仕事。触らずに抜ける。
    if (error instanceof RepairTakenOverError) throw error;
    // 名前が別のリポジトリに移っていた。読み取り専用にするのも名前で送るので、
    // ここで掛けにいくと無関係なリポジトリを止めてしまう。触らずに投げ直す。
    if (error instanceof RepositoryMovedError) throw error;
    // 長いコミットの後に握りが切れていることがある。読み取り専用にするのも
    // 外部への変更なので、その直前にも確かめる。
    await renewNameHold();
    await holdRepair(repository.id, epoch);
    await assertStillNamed(sudo, repository);
    // **掛ける前に控える。** 掛けてから控えると、控えを書けなかったときに
    // 「読み取り専用だが、誰が掛けたか分からない」状態が残る。次の周回は
    // locked=false を読むので外せず、利用者のリポジトリが止まったまま
    // 控えだけ消える。先に控えておけば、書けなければ掛けない。
    //
    // 逆に「控えたが掛からなかった」場合は害が無い。外す側は archived かどうかを
    // 見てから動くので、掛かっていなければ何もしない。
    const noted = await markGitRepositoryRepairLocked({
      forgejoRepoId: repository.id,
      intentId: epoch,
    }).catch(() => false);
    const locked = noted
      ? await lockRepository(
          sudo,
          repository,
          error instanceof Error ? error.message : String(error),
          pending,
        )
      : false;
    if (!noted) {
      console.error(
        `could not record that ${sudo}/${repository.name} is being locked; ` +
          "leaving it writable and retrying next round",
      );
    }
    return locked
      ? { state: "locked", error, pending: pending.value }
      : { state: "open", error, pending: pending.value };
  }
}

/** 直せなければ投げる。利用者に返す経路で使う。 */
async function requireRepairedTemplates(
  sudo: string,
  repository: ForgejoRepository,
  epoch: string,
  nameHold?: { id: string; epoch: string },
): Promise<void> {
  const outcome = await repairTemplates(sudo, repository, epoch, nameHold);
  if (outcome.state === "repaired") return;
  // 結果が分からないまま終わったものは、そうと分かる形で投げる。呼び出し元は
  // これを見て名前の予約を残す (外すと、遅れて着地した変更が別のリポジトリに
  // 当たる)。
  if (outcome.pending) {
    throw new RepairPendingError(repository.id, outcome.error);
  }
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
 * 予約を握って進める外部呼び出しの待ち時間の上限。
 *
 * **期限より短く切る。** 切らないと、応答を待っている間に期限が過ぎ、定期実行に
 * 引き取られた後も自分は気付かないまま作成や改名を続けることになる。
 */
const HELD_REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * 相手が見つからない予約を諦めるまでの幅。
 *
 * 待つのをやめた後も Forgejo 側の処理は続くことがある。1 回見つからないだけで
 * 予約を外すと、その後に現れた預かりものが誰にも追われないまま残り、名前も
 * 空いてしまう。しばらく見続けてから外す。
 */
const CREATION_MISSING_GRACE_MS = 30 * 60 * 1000;

/**
 * 削除の予約を「行われなかった」と判断するまでの幅。
 *
 * **待ち時間切れは、Forgejo が削除をやめたことの証明ではない。** こちらが待つのを
 * やめただけで、向こうはまだ処理の途中かもしれない。まだ残っているのを見た瞬間に
 * 名前を解放すると、同じ名前で作り直された後に古い削除が着地しうる。
 *
 * 相手が消えていれば、その時点で言い切れるので待たない。残っている場合だけ、
 * 要求が始まってからこの幅を過ぎるまで押さえたままにする。
 */
const DELETE_LATE_GRACE_MS = 30 * 60 * 1000;

/**
 * 押さえただけの名前を手放すまでの幅。
 *
 * 説明文の書き換えは、結果が分からなければ名前を押さえたまま終わる。控えは
 * 積まない (直す作業が残っているわけではない) ので、片付けるのは予約の期限が
 * 切れた後のここになる。期限は 10 分で、定期実行の間隔を足しても 30 分に届かない。
 * それでは、遅れて着地しうる幅として他で受け入れている 30 分より短くなり、
 * 手放した後に着地した PATCH が、その名前を取った別のリポジトリに当たる。
 *
 * 予約が**作られてから**この幅を過ぎるまでは手放さない。
 */
const HOLD_LATE_GRACE_MS = 30 * 60 * 1000;

/**
 * 期限を延ばしてから、送った変更が終わるまでに経ちうる時間。
 *
 * 延ばした直後に id を確かめ (1 往復)、そのうえで本体を送る (もう 1 往復)。
 * どちらも上限まで待つことがある。起点を「最後に延ばした時刻」に取ると、その分
 * だけ猶予が短くなるので、足して数える。
 */
const HOLD_ANCHOR_SLACK_MS = 2 * HELD_REQUEST_TIMEOUT_MS;

/**
 * その予約に最後に触れた時刻。
 *
 * **作った時刻から数えない。** 期限は各 mutation の直前に延ばしているので、
 * 期限から持ち幅を引けば「最後に送ろうとした時刻」になる。作った時刻を起点に
 * すると、操作にかかった分だけ猶予が短くなり、遅れて着地しうる幅を割り込む。
 */
function lastTouched(entry: {
  createdAt: Date;
  leaseUntil: Date | null;
}): number {
  return entry.leaseUntil
    ? entry.leaseUntil.getTime() - CREATION_LEASE_MS
    : entry.createdAt.getTime();
}

/**
 * 1 回の片付けで見る行数の上限 (片付ける上限の何倍まで走査するか)。
 *
 * 触らずに飛ばす行 (直しが押さえている名前など) は古い順の先頭に居座り続ける。
 * 取得件数で打ち切ると、その後ろにある放置された作成・改名・削除へ永久に
 * 届かない。飛ばした分は数えずに頁を進め、走査そのものにだけ上限を置く。
 */
const RECONCILE_SCAN_FACTOR = 10;

/**
 * 照合できない予約を諦めるまでの幅。
 *
 * 元の名前が控えられていない改名の予約は、何度見ても判断材料が増えない。押さえた
 * ままにすると外す条件が永久に来ず、その名前を恒久的に塞ぐ。何もせずに名前だけ
 * 手放すのは安全な側 (利用者のリポジトリには触らない)。要求が始まってからこの幅を
 * 過ぎたら、記録を残して外す。
 */
const UNMATCHABLE_RESERVATION_GRACE_MS = 30 * 60 * 1000;

/**
 * 改名で**元の名前**を押さえている行の預かり名。
 *
 * 行き先の行と役目が違う。行き先は「その名前を先に押さえる」ためのもので、
 * 元の名前の側は「改名し終えるまでその名前を空けない」ためのもの。だから
 * 済んだかどうかの見方も違う (行き先は最終名になったか、元の側はその名前から
 * 動いたか)。名前だけでは区別できないので、預かり名で分ける。
 */
const RENAME_SOURCE_PREFIX = "beutl-rename-src-";

/** 預かり名の接頭辞。行に何の操作かを持たせる前から、これだけは付けてきた。 */
const HOLDING_PREFIXES = [
  { prefix: "beutl-delete-", operation: GitRepositoryOperation.DELETE },
  { prefix: "beutl-rename-", operation: GitRepositoryOperation.RENAME },
] as const;

/**
 * 予約が何をしている最中のものかを決める。
 *
 * **列の値だけを信じない。** `operation` は後から足した列で、既定値は CREATE。
 * migration を先に当てて Worker を後から入れ替える手順では、その間に旧 Worker が
 * 積んだ行が CREATE のまま残り、後から分類し直す機会がもう無い。CREATE として
 * 拾うと、改名の後始末が預かりものの流れに入り、利用者が編集した .gitattributes を
 * 「直す」対象にしてしまう。
 *
 * 預かり名の接頭辞は最初から付いているので、そちらでも判断する。
 */
function reservationOperation(entry: {
  operation: GitRepositoryOperation;
  holdingName: string;
}): GitRepositoryOperation {
  if (entry.operation !== GitRepositoryOperation.CREATE) return entry.operation;
  const known = HOLDING_PREFIXES.find((candidate) =>
    entry.holdingName.startsWith(candidate.prefix),
  );
  return known ? known.operation : entry.operation;
}

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
    reservationId: string | null;
    /** この直しが読み取り専用を掛けたか。片付ける前に外す必要がある。 */
    locked: boolean;
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

  // **これから触る名前を押さえる。** 押さえずに進めると、id を確かめてから送る
  // までの 1 往復の間に相手が改名され、空いた名前を取った別のリポジトリへ
  // .gitattributes を書き、読み取り専用を掛けてしまう。
  // 控えが控えている予約は、渡し切る途中で落ちた自分たちの取り残し。名前が
  // 塞がっていたらそれを引き継ぐ (取り直しは一意キーに阻まれて通らない)。
  const held = await holdName(
    owner,
    current.name,
    entry.forgejoRepoId,
    epoch,
    entry.reservationId,
  );
  if (held === null) {
    // 今その名前を誰かが動かしている (作成・改名・削除のどれか)。割り込まない。
    // 控えは残るので、次の周回でやり直す。
    return false;
  }
  // **結果が分からない場合は名前を手放さない。** 待ち時間切れ・5xx は、Forgejo
  // 側の処理が後から確定することがある。ここで外すと、その間に別の作成が同じ名前
  // を取り、遅れて着地した直しが別のリポジトリに当たる。改名・削除と同じ扱い。
  // 4xx は「受け付けられなかった」と言い切れるので外してよい。
  let keepName = false;
  try {
    return await settleHeldRepair(
      entry,
      epoch,
      current,
      owner,
      admin,
      handover,
      held,
    );
  } catch (error) {
    if (!isDecided(error)) keepName = true;
    throw error;
  } finally {
    if (!keepName) await releaseName(held, epoch);
  }
}

/**
 * 名前を押さえた状態で直しを進める。@returns 控えを外してよいか。
 *
 * 押さえているのは `current` の時点の (所有者, 名前)。譲渡でそこから動く場合は、
 * 動いた先の名前を handOver がもう一度押さえる。
 */
async function settleHeldRepair(
  entry: {
    forgejoRepoId: number;
    intendedOwner: string | null;
    intendedName: string | null;
    reservationId: string | null;
    /** この直しが読み取り専用を掛けたか。片付ける前に外す必要がある。 */
    locked: boolean;
  },
  epoch: string,
  current: ForgejoRepository,
  owner: string,
  admin: string,
  handover: { owner: string; name: string } | null,
  held: string,
): Promise<boolean> {
  const nameHold = { id: held, epoch };

  // **押さえた後にもう一度確かめる。** 押さえる前に見た姿は、押さえた時点の姿とは
  // 限らない。ここを通れば、以後この名前は誰も動かせない。
  await renewName(held, epoch);
  await assertStillNamed(owner, current);

  // 既定値が揃っているかも名前で読む。揃っていた場合は何も送らずに片付ける
  // ことになるので、**読んだ相手がこの id だったこと**を確かめてから決める。
  // 確かめずに片付けると、入れ替わった別のリポジトリの中身を見て、直っていない
  // リポジトリの控えを外すことになる。
  if (await hasTemplates(owner, current.name)) {
    await renewName(held, epoch);
    await assertStillNamed(owner, current);
    // **この直しが掛けた読み取り専用は、片付ける前に外す。**
    //
    // 前の周回で「直せなかった」として archive を掛け、その後に遅れてコミットが
    // 着地する、という順序が起こりうる。既定値は揃っているので直しは片付くが、
    // 掛けた archive はそのまま。外さずに控えを消すと、利用者のリポジトリが
    // 読み取り専用のまま、誰にも追われずに残る。
    //
    // 外すのは**自分が掛けたと控えてあるとき**だけ。控えが無いものに触ると、
    // 利用者が意図して掛けたものを外すことになる。
    if (entry.locked && current.archived) {
      await holdRepair(entry.forgejoRepoId, epoch);
      await assertStillNamed(owner, current);
      await setRepositoryArchived(owner, current.name, false);
    }
  } else {
    const outcome = await repairTemplates(owner, current, epoch, nameHold);
    if (outcome.state !== "repaired") {
      // **送ったものが確定していないなら、まだ片付いていない。** 読み取り専用に
      // できていても、遅れて着地した unarchive や commit がその後に効けば、
      // 既定値の入っていないリポジトリがまた書き込み可能になる。投げれば外側が
      // 名前を保持し、控えも残る (次の周回で id から引き直して決着を付ける)。
      if (outcome.pending) {
        throw new RepairPendingError(entry.forgejoRepoId, outcome.error);
      }
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
      nameHold,
    );
    if (entry.reservationId) {
      await releaseGitRepositoryReservation({ id: entry.reservationId }).catch(
        () => undefined,
      );
    }
    return true;
  }
  // 譲渡は済んでいて改名だけが残っている。
  if (current.name !== handover.name) {
    await holdRepair(entry.forgejoRepoId, epoch);
    await assertStillNamed(owner, current);
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
  if (entry.reservationId) {
    await releaseGitRepositoryReservation({ id: entry.reservationId }).catch(
      () => undefined,
    );
  }
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
  const admin = await getAdminUsername();
  // **打ち切るのは「片付けた数」で。** 取得した数で打ち切ると、触らずに飛ばす
  // 行が先頭を占め続けたときに、その後ろへ永久に届かない。
  //
  // 走査そのものにも上限がある。飛ばす行がその上限を超えて並ぶと、今度はそこで
  // 頭打ちになる。上限に当たった位置を控え、次の周回はその続きから読む。
  const scanLimit = limit * RECONCILE_SCAN_FACTOR;
  let handled = 0;
  let scanned = 0;
  // 走査の上限に当たった位置は DB に置く。Worker の記憶だと isolate が
  // 入れ替わるたびに消え、飛ばす行が先頭に並んだままだと同じところで止まり続ける。
  let after: string | undefined = (await getGitReconcileCursor()) ?? undefined;

  while (handled < limit && scanned < scanLimit) {
    const page = await listExpiredGitRepositoryCreations({ limit, after });
    if (page.length === 0) break;
    after = page[page.length - 1].id;

    for (const entry of page) {
      if (handled >= limit || scanned >= scanLimit) break;
      scanned += 1;
      // **掴む前に、控え側が持っているものかを見る。**
      //
      // 掴むと期限が伸びる。控え側の引き継ぎ (adoptName) は期限切れを条件に
      // しているので、ここで伸ばすと引き継げなくなる。片付けもしないまま毎周回
      // 伸ばし続けることになり、控えと予約が互いを待って永久に止まる。
      const queued =
        entry.forgejoRepoId == null
          ? null
          : await findGitRepositoryRepair({
              forgejoRepoId: entry.forgejoRepoId,
            });
      // 人の確認待ちは自動では再開しない。控えがあっても引き継ぐ相手がいない。
      const willRetry = queued !== null && !queued.needsReview;

      // **名前を押さえていただけの予約。** Forgejo は見ない。やり残した作業は控え
      // (リポジトリ id) の側にあるので、ここは名前を手放すだけでよい。見に行くと、
      // 相手の今の姿によっては預かりものの流れに乗せてしまい、利用者が編集した
      // .gitattributes を「直す」対象にする。
      //
      // **ただし、対応する直しがまだ回るなら外さない。** 直しは複数の API 呼び出しを
      // 行い、その間に名前の期限が切れることがある。期限が切れたからと外すと、
      // 実行中の直しと並行して同じ名前を別の作成が取れる。名前は直し側が引き継ぐ。
      const repairHold = entry.holdingName.startsWith(REPAIR_HOLDING_PREFIX);
      if (repairHold) {
        if (willRetry) continue;
        // **遅れて着地しうる幅は空ける。** 説明文の書き換えのように控えを積まない
        // 操作は、結果が分からないまま押さえたままここへ来る。期限切れで即座に
        // 手放すと、後から着地した PATCH がその名前を取った別のリポジトリに当たる。
        if (
          Date.now() - lastTouched(entry) <
          HOLD_LATE_GRACE_MS + HOLD_ANCHOR_SLACK_MS
        ) continue;
      }

      // 既に控えに載っているなら、片付けは控え側の仕事。ここで触ると持ち主が
      // 2 つに分かれる。渡し切った側が予約も外す。
      if (!repairHold && queued !== null) continue;

      // 掴む。期限内のもの (前面が進めているもの) は返ってこない。
      const epoch = crypto.randomUUID();
      if (
        !(await claimGitRepositoryCreation({
          id: entry.id,
          intentId: epoch,
          leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
        }))
      ) {
        // 期限内 = 前面の処理が持っている。飛ばした分は数えない。
        continue;
      }
      // ここから先はどう転んでも「1 件片付けにいった」。
      handled += 1;

      try {
        // 控えが無い、または人の確認待ちで止まっている預かり名。誰も引き継がない
        // ので、押さえたままにするとその名前を永久に塞ぐ。手放すだけでよい
        // (着地の猶予は掴む前に見てある)。
        if (repairHold) {
          await releaseGitRepositoryReservation({
            id: entry.id,
            intentId: epoch,
          });
          continue;
        }

        // id が分かっていればそれで、分からなければ預かり名で引く。
        const holding = entry.forgejoRepoId
          ? await forgejoRequestOrNull<ForgejoRepository>(
              `/repositories/${entry.forgejoRepoId}`,
            )
          : await getRepository(admin, admin, entry.holdingName);

        // **最終形になっているときだけ**外す。最終形とは「渡す先が持っていて、
        // 名前も最終名」であること。管理者以外が持っているだけでは足りない
        // (第三者が最終名を持っている場合も同じ見え方になる)。
        //
        // 名前は**そのまま**比べる。小文字化して比べると、proj → Proj のような
        // 大小だけの改名が済んでいなくても「同じ」に見えて完了扱いになる。
        const settled =
          holding !== null &&
          holding.owner.login.toLowerCase() ===
            entry.ownerUsername.toLowerCase() &&
          holding.name === entry.name;
        const operation = reservationOperation(entry);

        // 削除の予約は、消えたかどうかを確かめるだけ。**自動では消し直さない。**
        // 消すのは取り返しがつかないので、残っていたら「行われなかった」として
        // 名前を解放し、やり直すかどうかは利用者に委ねる。
        if (operation === GitRepositoryOperation.DELETE) {
          if (holding) {
            // **まだ残っている = 削除が行われなかった、ではない。** 待つのをやめた
            // 後に Forgejo が確定させることがある。始めてからしばらくは押さえたまま
            // にして、それでも残っていたら「行われなかった」として名前を解放する。
            if (Date.now() - entry.createdAt.getTime() < DELETE_LATE_GRACE_MS) {
              continue;
            }
            console.warn(
              `delete reservation ${entry.id} still sees ` +
                `${holding.owner.login}/${holding.name}; the deletion did not take effect`,
            );
          }
          await releaseGitRepositoryReservationsByIntent({
            intentId: entry.intentId ?? epoch,
          }).catch(() => undefined);
          await releaseGitRepositoryReservation({
            id: entry.id,
            intentId: epoch,
          });
          continue;
        }

        // **元の名前を押さえていた行。** 役目は「改名し終えるまでその名前を空けない」
        // ことなので、相手がその名前から動いていれば済んでいる。
        //
        // これを行き先の行と同じ物差しで見ると、押さえているのは旧名なのに最終名と
        // 比べることになり、改名が通っていても永久に食い違う。旧名がずっと再利用
        // できなくなる。
        if (
          holding &&
          entry.holdingName.startsWith(RENAME_SOURCE_PREFIX) &&
          entry.sourceName !== null
        ) {
          const stillAtSource =
            holding.owner.login.toLowerCase() ===
              entry.ownerUsername.toLowerCase() &&
            holding.name === entry.sourceName;
          if (!stillAtSource) {
            // その名前から動いた。行き先の行と一緒に外す。
            await releaseGitRepositoryReservationsByIntent({
              intentId: entry.intentId ?? epoch,
            }).catch(() => undefined);
            await releaseGitRepositoryReservation({
              id: entry.id,
              intentId: epoch,
            });
            continue;
          }
          // まだ元の名前のまま。改名は行き先の行がやり直す。こちらは押さえたまま。
          continue;
        }

        // 改名の予約は、名前が変わったかを確かめるだけ。控えに載せて渡し切る流れに
        // 乗せると、利用者が編集した .gitattributes を「直す」対象にしてしまう。
        if (
          holding &&
          !settled &&
          operation === GitRepositoryOperation.RENAME
        ) {
          // 元の名前が控えられていない行は、何度見ても判断材料が増えない。
          // 押さえたままだと名前を恒久的に塞ぐので、しばらく置いてから手放す。
          // 何もせずに手放すだけなので、利用者のリポジトリには触らない。
          if (entry.sourceName === null) {
            if (
              Date.now() - entry.createdAt.getTime() <
              UNMATCHABLE_RESERVATION_GRACE_MS
            ) {
              continue;
            }
            console.error(
              `rename reservation ${entry.id} has no source name; ` +
                `releasing ${entry.ownerUsername}/${entry.name} without renaming`,
            );
            await releaseGitRepositoryReservationsByIntent({
              intentId: entry.intentId ?? epoch,
            }).catch(() => undefined);
            await releaseGitRepositoryReservation({
              id: entry.id,
              intentId: epoch,
            });
            continue;
          }
          // 控えてある元の名前と**そのまま**突き合わせる。「今の名前が元の名前だ」と
          // 読み替えると、利用者が後から付け直した名前まで書き換えてしまう。
          if (
            holding.owner.login.toLowerCase() ===
              entry.ownerUsername.toLowerCase() &&
            holding.name === entry.sourceName
          ) {
            // まだ元の名前のまま。改名だけやり直す。
            await holdReservation(entry.id, epoch);
            // 送るのは名前。その名前がまだこの相手を指しているかを直前に確かめる。
            await assertStillNamed(holding.owner.login, holding);
            await forgejoRequest(
              `/repos/${encodeURIComponent(holding.owner.login)}/${encodeURIComponent(holding.name)}`,
              {
                method: "PATCH",
                body: { name: entry.name },
                timeoutMs: HELD_REQUEST_TIMEOUT_MS,
              },
            );
            // 行き先と元の 2 本をまとめて外す。
            await releaseGitRepositoryReservationsByIntent({
              intentId: entry.intentId ?? epoch,
            }).catch(() => undefined);
            await releaseGitRepositoryReservation({
              id: entry.id,
              intentId: epoch,
            });
            continue;
          }
          // 元の名前でも最終名でもない。自動では決められない。
          console.error(
            `rename reservation ${entry.id} points at ${holding.owner.login}/${holding.name}, ` +
              `expected ${entry.ownerUsername}/${entry.sourceName ?? "?"} or ${entry.name}`,
          );
          continue;
        }

        if (holding && !settled) {
          // 控えに載せ替える。**予約は外さない。** ここで外すと、渡し終わる前に
          // 同じ名前を再び予約でき、2 つの預かりものが同じ相手に渡る。
          // 外すのは渡し切った側 (settleRepositoryRepair)。第三者が持っている
          // 場合も、そこで人の確認に回る。
          // 見つかったので、見失った記録は消す。
          await clearGitRepositoryCreationMissing({
            id: entry.id,
            intentId: epoch,
          });
          await queueRepair(admin, holding, "abandoned before hand-over", {
            handover: {
              intendedOwner: entry.ownerUsername,
              intendedName: entry.name,
            },
            reservationId: entry.id,
            required: true,
          });
          continue;
        }

        if (!holding) {
          // **1 回見つからないだけでは外さない。** 待つのをやめた後に Forgejo が
          // 確定させることがある。しばらく見続けて、それでも現れなければ外す。
          const missingSince = await markGitRepositoryCreationMissing({
            id: entry.id,
            intentId: epoch,
          });
          if (
            missingSince &&
            Date.now() - missingSince.getTime() < CREATION_MISSING_GRACE_MS
          ) {
            continue;
          }
          await releaseGitRepositoryReservation({
            id: entry.id,
            intentId: epoch,
          });
          continue;
        }

        // 最終形になっている。予約は不要。
        await clearGitRepositoryCreationMissing({
          id: entry.id,
          intentId: epoch,
        });
        await releaseGitRepositoryReservation({
          id: entry.id,
          intentId: epoch,
        });
      } catch (error) {
        // 分からないまま外さない。次の周回でやり直す。
        console.error(
          `could not reconcile the reservation of ${entry.ownerUsername}/${entry.name}`,
          error,
        );
      }
    }
  }

  // **打ち切ったことを黙って伏せない。** 何件見て何件片付けたかを言わないと、
  // 届いていない行があっても「片付いた」と読める。
  if (scanned >= scanLimit && handled < limit) {
    // 次の周回はここから読む。先頭へ戻すと、飛ばす行が上限を超えて並んだときに
    // 毎回同じところで止まり、その後ろへ永久に届かない。
    await setGitReconcileCursor({ after: after ?? null }).catch(() => undefined);
    console.warn(
      `reconcile stopped after scanning ${scanned} reservations and settling ` +
        `${handled}; the next run resumes after ${after ?? "the start"}`,
    );
  } else {
    // 最後まで読み切った。次は先頭から。
    await setGitReconcileCursor({ after: null }).catch(() => undefined);
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
  /** 呼び出し元が押さえている出発地の名前。譲渡の前に延ばす。 */
  sourceHold?: { id: string; epoch: string },
): Promise<ForgejoRepository> {
  // 譲渡でリポジトリは (管理者, 預かり名) から (渡す先, 預かり名) へ動く。
  // **動いた先の名前も押さえてから譲渡する。** 押さえずに送ると、譲渡の直後から
  // 最後の改名までの間、渡す先の名前空間でその名前を誰も守っていない状態になる。
  // 渡した瞬間から利用者はそのリポジトリの持ち主なので、そこは操作が届く場所。
  const landing = await holdName(intendedOwner, holdingName, repoId, epoch);
  if (landing === null) {
    throw new ForgejoError(
      409,
      "POST",
      `/repos/${admin}/${holdingName}/transfer`,
      `${intendedOwner}/${holdingName} is being used by another operation`,
    );
  }

  // **結果が分からない場合は着地名を手放さない。** 譲渡・改名とも 5xx・待ち時間
  // 切れは後から着地しうる。外すとその間に別の作成が同じ名前を取る。
  let keepLanding = false;
  try {
    // ここで初めて利用者のものになる。既定値は入り終わっている。
    // id は変わらない (16.0.2 で実測)。
    if (sourceHold) await renewName(sourceHold.id, sourceHold.epoch);
    await renewName(landing, epoch);
    await holdRepair(repoId, epoch);
    await assertStillNamed(admin, { id: repoId, name: holdingName });
    const transferred = await forgejoRequest<ForgejoRepository>(
      `/repos/${encodeURIComponent(admin)}/${encodeURIComponent(holdingName)}/transfer`,
      { method: "POST", body: { new_owner: intendedOwner } },
    );
    if (transferred.name === intendedName) return transferred;
    // 押さえてあるのは預かり名。Forgejo が別の名前を返したなら、押さえていない
    // 名前に対して送ることになる。そのまま進めず、次の周回に委ねる。
    if (transferred.name !== holdingName) {
      throw new ForgejoError(
        409,
        "PATCH",
        `/repos/${intendedOwner}/${transferred.name}`,
        `transfer returned ${transferred.name}, expected ${holdingName} or ${intendedName}`,
      );
    }
    await renewName(landing, epoch);
    await holdRepair(repoId, epoch);
    await assertStillNamed(intendedOwner, {
      id: repoId,
      name: transferred.name,
    });
    // 預かり名は毎回違うので、渡した後に本来の名前へ直す。名前が空いていることは
    // 作成の前に確かめてある。
    return await forgejoRequest<ForgejoRepository>(
      `/repos/${encodeURIComponent(intendedOwner)}/${encodeURIComponent(transferred.name)}`,
      { method: "PATCH", body: { name: intendedName } },
    );
  } catch (error) {
    if (!isDecided(error)) keepLanding = true;
    throw error;
  } finally {
    if (!keepLanding) await releaseName(landing, epoch);
  }
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
  // **予約を先に取る。** Forgejo で 404 を見てから予約を取ると、その間に別の
  // 作成が最初から最後まで通り、こちらは古い 404 を信じて預かりものを作って
  // しまう。名前を押さえてから見る。
  const reservationEpoch = crypto.randomUUID();
  const holdingName = `beutl-holding-${crypto.randomUUID()}`;
  const reservation = await reserveGitRepositoryName({
    ownerUsername: sudo,
    name,
    holdingName,
    intentId: reservationEpoch,
    leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
  });

  const conflicting = await getRepository(sudo, sudo, name).catch(
    async (error) => {
      await releaseGitRepositoryReservation({
        id: reservation,
        intentId: reservationEpoch,
      }).catch(() => undefined);
      throw error;
    },
  );
  if (conflicting) {
    // **予約はここでは外さない。** 下の修復はこの名前に対して送るので、外して
    // しまうと直している最中に別の作成や改名がその名前を取れる。決着してから外す。
    // 決着が付かなかった場合 (送ったものが確定していない場合) も外さない。
    let keepReservation = false;
    try {
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
      try {
        await requireRepairedTemplates(sudo, conflicting, epoch, {
          id: reservation,
          epoch: reservationEpoch,
        });
      } catch (error) {
        // **送ったものが確定していないなら、名前は手放さない。** 手放すと、
        // 遅れて着地した unarchive や commit が、その名前を取った別の
        // リポジトリに当たる。控えは acquireRepair が積んであるので、
        // 次の周回が id から引き直して決着を付ける。
        if (error instanceof RepairPendingError) keepReservation = true;
        throw error;
      }
      // 直った。控えに残す理由が無い。
      await deleteGitRepositoryRepair({
        forgejoRepoId: conflicting.id,
        intentId: epoch,
      }).catch(() => undefined);
      return conflicting;
    } finally {
      if (!keepReservation) {
        await releaseGitRepositoryReservation({
          id: reservation,
          intentId: reservationEpoch,
        }).catch(() => undefined);
      }
    }
  }

  const admin = await getAdminUsername();
  let holding: ForgejoRepository;
  try {
    // 作る直前にも握りを確かめる。ここまでで期限が切れていたら、定期実行が
    // 予約を引き取っている。
    await holdReservation(reservation, reservationEpoch);
    // 待ち時間は期限より短く切る (下の holdReservation まで届くように)。
    // Sudo を付けない = 管理者自身の名前空間に作る。
    holding = await forgejoRequest<ForgejoRepository>("/user/repos", {
      method: "POST",
      timeoutMs: HELD_REQUEST_TIMEOUT_MS,
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
    // **予約は残す。** POST が落ちたのか、応答だけが落ちたのかは分からない。
    // この時点の 404 も確定ではない (Forgejo 側の処理が続いていて、後から
    // 現れることがある)。期限が切れた後に定期実行が引き直して判断する。
    const existing = await getRepository(admin, admin, holdingName).catch(
      () => null,
    );
    if (!existing) throw error;
    holding = existing;
  }

  // 応答で初めて分かる id を予約に紐付ける。これで、この先どこで落ちても
  // 定期実行が id で引き直せる。
  // **作った後にもう一度握りを確かめる。** 応答を待っている間に期限が切れて
  // いれば、定期実行が予約を引き取っている。気付かずに進めると、相手が予約を
  // 解放した後に別の要求が同じ名前を取り、預かりものが 2 つになる。
  await holdReservation(reservation, reservationEpoch);

  // 紐付けられない = 引き取られている。**続けない。**
  if (
    !(await attachGitRepositoryCreationId({
      id: reservation,
      intentId: reservationEpoch,
      forgejoRepoId: holding.id,
    }))
  ) {
    throw new RepairTakenOverError(holding.id);
  }

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
      reservation,
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
      await releaseGitRepositoryReservation({
        id: reservation,
        intentId: reservationEpoch,
      }).catch(() => undefined);
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
      { id: reservation, epoch: reservationEpoch },
    );
    await deleteGitRepositoryRepair({
      forgejoRepoId: holding.id,
      intentId: epoch,
    }).catch(() => undefined);
    await releaseGitRepositoryReservation({
      id: reservation,
      intentId: reservationEpoch,
    }).catch(() => undefined);
    return handed;
  } catch (error) {
    if (error instanceof RepairTakenOverError) throw error;
    if (await discardHolding(admin, holding, epoch)) {
      await releaseGitRepositoryReservation({
        id: reservation,
        intentId: reservationEpoch,
      }).catch(() => undefined);
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
  const current = await getRepository(sudo, owner, name);
  if (!current) {
    throw new ForgejoError(
      404,
      "PATCH",
      `/repos/${owner}/${name}`,
      `repository ${owner}/${name} does not exist`,
    );
  }

  const renameEpoch = crypto.randomUUID();
  // **行き先と元の両方を押さえる。** 行き先だけだと、元の名前が消えたり別の
  // リポジトリに付け替えられたりしたときに、名前で送る PATCH が別物に当たる。
  const targetReservation = await reserveGitRepositoryName({
    ownerUsername: owner,
    name: newName,
    holdingName: `beutl-rename-${crypto.randomUUID()}`,
    operation: GitRepositoryOperation.RENAME,
    sourceName: name,
    intentId: renameEpoch,
    leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
  });
  // 大小だけの改名では、行き先と元が同じ鍵になる (一意キーは小文字化した組)。
  // 2 本目を取ろうとすると自分の 1 本目とぶつかるので、1 本で兼ねる。
  const sameKey =
    normalizeRepositoryName(name) === normalizeRepositoryName(newName);
  let sourceReservation: string | null = null;
  if (!sameKey) {
    try {
      sourceReservation = await reserveGitRepositoryName({
        ownerUsername: owner,
        name,
        holdingName: `${RENAME_SOURCE_PREFIX}${crypto.randomUUID()}`,
        operation: GitRepositoryOperation.RENAME,
        sourceName: name,
        intentId: renameEpoch,
        leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
      });
    } catch (error) {
      await releaseGitRepositoryReservation({
        id: targetReservation,
        intentId: renameEpoch,
      }).catch(() => undefined);
      throw error;
    }
  }

  // 決着が付いたら**まとめて**外す。片方だけ外すと、残った方が要らなくなった
  // 名前を期限まで塞ぎ続ける。
  const releaseBoth = async () => {
    await releaseGitRepositoryReservationsByIntent({
      intentId: renameEpoch,
    }).catch(() => undefined);
  };

  try {
    // 相手の id を控える。結果が分からなくなった場合、定期実行がこれで引き直す。
    // **書けなければ進めない。** 控えが無いと、曖昧に終わった改名を誰も
    // 照合できない。
    if (
      !(await attachGitRepositoryCreationId({
        id: targetReservation,
        intentId: renameEpoch,
        forgejoRepoId: current.id,
      }))
    ) {
      throw new RepairTakenOverError(current.id);
    }

    // 元の名前を押さえた行にも同じ相手を控える。**こちらも書けなければ進めない。**
    // 控えが無い行は、回収のときに偽の預かり名を探しにいくことしかできず、
    // 要らなくなった名前を期限まで塞ぎ続ける。行き先の行から辿れるとはいえ、
    // それは片方が生き残っている場合の話でしかない。
    if (
      sourceReservation &&
      !(await attachGitRepositoryCreationId({
        id: sourceReservation,
        intentId: renameEpoch,
        forgejoRepoId: current.id,
      }))
    ) {
      throw new RepairTakenOverError(current.id);
    }

    // **送る直前に相手を確かめ直す。** 上の GET から間が空くと、その名前が別の
    // リポジトリに付け替わっていることがある (削除して作り直しなど)。
    // 名前でしか送れない (PATCH /repositories/{id} は 405) ので、開いている幅は
    // この確認から送信までの 1 往復に縮める。
    const stillThere = await forgejoRequestOrNull<ForgejoRepository>(
      `/repositories/${current.id}`,
      { timeoutMs: HELD_REQUEST_TIMEOUT_MS },
    );
    if (
      !stillThere ||
      stillThere.owner.login.toLowerCase() !== owner.toLowerCase() ||
      stillThere.name !== name
    ) {
      await releaseBoth();
      throw new ForgejoError(
        409,
        "PATCH",
        `/repos/${owner}/${name}`,
        `repository ${owner}/${name} is no longer id ${current.id}`,
      );
    }

    // **送る直前に握りも確かめる。** 個々の呼び出しは上限内でも、DB の待ちを
    // 含めた全体が期限を越えることがある。越えた後に送ると、引き取った側の
    // 判断と食い違う。
    await holdReservation(targetReservation, renameEpoch);
    if (sourceReservation) {
      await holdReservation(sourceReservation, renameEpoch);
    }

    const renamed = await forgejoRequest<ForgejoRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        sudo,
        timeoutMs: HELD_REQUEST_TIMEOUT_MS,
        body: { name: newName },
      },
    );
    await releaseBoth();
    return renamed;
  } catch (error) {
    // **結果が分からない場合は予約を残す。** 待つのをやめただけで、Forgejo が
    // 後から確定させることがある。ここで外すと、その間に別の作成が同じ名前を
    // 取り、後から着地した改名とぶつかる。
    //
    // 4xx は「受け付けられなかった」と言い切れるので外してよい。5xx と、
    // 待ち時間切れなどの例外は残す。定期実行が id で引き直して決着を付ける。
    if (isDecided(error)) await releaseBoth();
    throw error;
  }
}

/**
 * 説明文を書き換える。
 *
 * **送る直前に相手を確かめる。** 改名で空いた名前を別のリポジトリが取ることが
 * あるので、名前だけで送ると他人の説明文を書き換えうる。改名や削除ほどの実害は
 * 無いが、名前で送る操作は全て同じ扱いにする。
 */
export async function updateRepositoryDescription(
  sudo: string,
  owner: string,
  name: string,
  description: string,
) {
  const current = await getRepository(sudo, owner, name);
  if (!current) {
    throw new ForgejoError(
      404,
      "PATCH",
      `/repos/${owner}/${name}`,
      `repository ${owner}/${name} does not exist`,
    );
  }

  const epoch = crypto.randomUUID();
  const held = await holdName(owner, name, current.id, epoch);
  if (held === null) {
    throw new ForgejoError(
      409,
      "PATCH",
      `/repos/${owner}/${name}`,
      `${owner}/${name} is being used by another operation`,
    );
  }

  // **結果が分からない場合は名前を手放さない。** 5xx・待ち時間切れは後から
  // 確定しうる。外すとその間に別の作成が同じ名前を取る。4xx は外してよい。
  let keepName = false;
  try {
    await renewName(held, epoch);
    await assertStillNamed(owner, { id: current.id, name });
    return await forgejoRequest<ForgejoRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "PATCH",
        sudo,
        timeoutMs: HELD_REQUEST_TIMEOUT_MS,
        body: { description },
      },
    );
  } catch (error) {
    if (!isDecided(error)) keepName = true;
    throw error;
  } finally {
    if (!keepName) await releaseName(held, epoch);
  }
}

/**
 * リポジトリを消す。
 *
 * **消す相手を名前だけで決めない。** 名前で引いてから送るまでの間に、その名前が
 * 別のリポジトリに渡ることがある (消して作り直しなど)。消すのは取り返しがつかない
 * ので、名前を押さえ、id で相手を確かめ直してから送る。
 *
 * `DELETE /repositories/{id}` は無いので、送るのは名前。開いている幅は確認から
 * 送信までの 1 往復に縮める。
 */
export async function deleteRepository(
  sudo: string,
  owner: string,
  name: string,
) {
  const current = await getRepository(sudo, owner, name);
  if (!current) {
    // 既に無い。消す相手がいない。
    return;
  }

  const deleteEpoch = crypto.randomUUID();
  const reservation = await reserveGitRepositoryName({
    ownerUsername: owner,
    name,
    holdingName: `beutl-delete-${crypto.randomUUID()}`,
    operation: GitRepositoryOperation.DELETE,
    sourceName: name,
    intentId: deleteEpoch,
    leaseUntil: new Date(Date.now() + CREATION_LEASE_MS),
  });
  if (
    !(await attachGitRepositoryCreationId({
      id: reservation,
      intentId: deleteEpoch,
      forgejoRepoId: current.id,
    }))
  ) {
    throw new RepairTakenOverError(current.id);
  }

  // 積んだ控えの印。決着を付けるときに、自分が積んだ行だけへ効かせる。
  let tombstone: { id: string; intentId: string } | null = null;
  try {
    await holdReservation(reservation, deleteEpoch);
    const stillThere = await forgejoRequestOrNull<ForgejoRepository>(
      `/repositories/${current.id}`,
      { timeoutMs: HELD_REQUEST_TIMEOUT_MS },
    );
    if (
      !stillThere ||
      stillThere.owner.login.toLowerCase() !== owner.toLowerCase() ||
      stillThere.name !== name
    ) {
      await releaseGitRepositoryReservationsByIntent({
        intentId: deleteEpoch,
      }).catch(() => undefined);
      throw new ForgejoError(
        409,
        "DELETE",
        `/repos/${owner}/${name}`,
        `repository ${owner}/${name} is no longer id ${current.id}`,
      );
    }

    // **消す前に控える。** 消去は Forgejo 側で完結し、こちらには何も残らない。
    // Forgejo をこの時点より前へ戻すと、消したはずのリポジトリが復活する。
    // 控えが無ければ、戻した後にそれを消し直したかどうかを誰も数えられない。
    //
    // 名前ではなく id で控える。名前は空いた後に別のリポジトリが取る。
    //
    // **この時点ではまだ「消えた」ではない。** 控えを書いただけの状態で消し直しの
    // 対象にすると、この後 403 や 422 で断られた削除を、定期実行が後から実行して
    // しまう。確かめてから confirm する。
    tombstone = await recordGitRepositoryDeletion({
      forgejoRepoId: current.id,
      ownerUsername: stillThere.owner.login,
      name: stillThere.name,
    });

    await forgejoRequest(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
        sudo,
        responseType: "none",
        timeoutMs: HELD_REQUEST_TIMEOUT_MS,
      },
    );
    await confirmGitRepositoryDeletion(tombstone);
    await releaseGitRepositoryReservationsByIntent({
      intentId: deleteEpoch,
    }).catch(() => undefined);
  } catch (error) {
    // **404 は「消えた」。** 確かめてから送るまでの間に別の経路が消したなら、
    // 目的は達している。控えを外すと、生き返っても誰も追えなくなる。
    if (error instanceof ForgejoError && error.isNotFound) {
      if (tombstone) await confirmGitRepositoryDeletion(tombstone);
      await releaseGitRepositoryReservationsByIntent({
        intentId: deleteEpoch,
      }).catch(() => undefined);
      return;
    }
    // それ以外の 4xx は言い切れる。待ち時間切れ・5xx は、消えたかどうか
    // 分からない。予約を残し、定期実行が id で引き直して決着を付ける。
    if (isDecided(error)) {
      // **控えも外す。** 断られた削除の控えを残すと、定期実行がそれを実行する。
      if (tombstone) {
        await dropGitRepositoryDeletion(tombstone).catch(() => undefined);
      }
      await releaseGitRepositoryReservationsByIntent({
        intentId: deleteEpoch,
      }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * 復元で生き返ったリポジトリを消し直す。
 *
 * **ここも名前を押さえてから送る。** `DELETE /repositories/{id}` は無いので、
 * 消すのは名前。id で相手を確かめてから送るまでの 1 往復の間に、そのリポジトリが
 * 改名され、空いた名前を別のリポジトリが取ることがある。押さえずに送ると、
 * 無関係なリポジトリを消してしまう — 取り返しがつかない。
 *
 * @returns 消したか (相手が居なければ false)。
 */
export async function deleteResurrectedRepository(entry: {
  forgejoRepoId: number;
  ownerUsername: string;
  name: string;
}): Promise<"deleted" | "gone" | "moved" | "busy"> {
  const current = await forgejoRequestOrNull<ForgejoRepository>(
    `/repositories/${entry.forgejoRepoId}`,
  );
  // 生き返っていない。
  if (!current) return "gone";

  // **控えた姿と違うなら触らない。** 復元で採番がやり直されると、同じ id を
  // 別のリポジトリが持ちうる。
  if (
    current.owner.login.toLowerCase() !== entry.ownerUsername.toLowerCase() ||
    current.name !== entry.name
  ) {
    return "moved";
  }

  const epoch = crypto.randomUUID();
  const held = await holdName(
    current.owner.login,
    current.name,
    entry.forgejoRepoId,
    epoch,
  );
  // 今その名前を誰かが動かしている。割り込まない。次の周回でやり直す。
  if (held === null) return "busy";

  let keepName = false;
  try {
    await renewName(held, epoch);
    // 押さえた後にもう一度。押さえる前に見た姿は、押さえた時点の姿とは限らない。
    await assertStillNamed(current.owner.login, current);
    await forgejoRequest(
      `/repos/${encodeURIComponent(current.owner.login)}/${encodeURIComponent(current.name)}`,
      {
        method: "DELETE",
        responseType: "none",
        timeoutMs: HELD_REQUEST_TIMEOUT_MS,
      },
    );
    return "deleted";
  } catch (error) {
    // 結果が分からないなら名前を手放さない。遅れて着地した削除が、その名前を
    // 取った別のリポジトリに当たる。
    if (!isDecided(error)) keepName = true;
    throw error;
  } finally {
    if (!keepName) await releaseName(held, epoch);
  }
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
