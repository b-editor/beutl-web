import {
  auditLogActions,
  claimGitRepositoryRepair,
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

export async function getRepository(
  sudo: string,
  owner: string,
  name: string,
) {
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
async function lockRepository(
  owner: string,
  repository: Pick<ForgejoRepository, "id" | "name">,
  reason: string,
): Promise<void> {
  try {
    await setRepositoryArchived(owner, repository.name, true);
  } catch (error) {
    console.error(
      `${owner}/${repository.name} could not be locked; queued for repair`,
      error,
    );
    await queueRepair(owner, repository, reason);
    return;
  }

  // 掛かった時点で push は通らなくなる。控えは「まだ push できる」ものだけを
  // 残すためのものなので、外す。直す経路は同名での作り直し。
  await deleteGitRepositoryRepair({ forgejoRepoId: repository.id }).catch(
    () => undefined,
  );
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
}

/** 後で片付けるために控える。ここが失敗したら、もう記録は残らない。 */
async function queueRepair(
  owner: string,
  repository: Pick<ForgejoRepository, "id" | "name">,
  reason: string,
): Promise<void> {
  await enqueueGitRepositoryRepair({
    forgejoRepoId: repository.id,
    ownerUsername: owner,
    name: repository.name,
    reason,
  }).catch((error) => {
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
async function repairTemplates(
  sudo: string,
  repository: ForgejoRepository,
): Promise<void> {
  const name = repository.name;
  // **外す前に控える。** 読み取り専用を外した直後に Worker ごと消えると、例外は
  // 捕まらず、書き込み可能で非 canonical なリポジトリが記録も無いまま残る。
  await queueRepair(sudo, repository, "repair in progress");
  try {
    // archived のままだと contents API は 423 を返す。直すには先に外す。
    if (repository.archived) await setRepositoryArchived(sudo, name, false);
    await commitTemplates(sudo, name, repository.default_branch);
    await assertTemplatesAreCanonical(sudo, name);
    // 揃った。控えに残す理由が無い。
    await deleteGitRepositoryRepair({ forgejoRepoId: repository.id }).catch(
      () => undefined,
    );
  } catch (error) {
    await lockRepository(
      sudo,
      repository,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
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
 * 入れ切れなかったテンプレートを後から入れ直す。定期実行から呼ぶ。
 *
 * 控えてあるのは **Forgejo のリポジトリ id**。名前で引き直すと、改名で空いた名前を
 * 取った別のリポジトリを止めてしまう。id で引き、そのとき返る名前に対して操作する。
 *
 * 直せたら控えを外す。直せなければ読み取り専用にする (それも失敗したら控えは残る)。
 *
 * @returns 片付いた件数と、まだ残っている件数。
 */
export async function retryGitRepositoryRepairs({
  limit = 20,
}: { limit?: number } = {}): Promise<{ fixed: number; pending: number }> {
  const cutoff = new Date(Date.now() - REPAIR_COOLDOWN_MS);
  const queued = await listGitRepositoryRepairs({
    notAttemptedSince: cutoff,
    limit,
  });
  let fixed = 0;

  for (const entry of queued) {
    if (
      !(await claimGitRepositoryRepair({
        forgejoRepoId: entry.forgejoRepoId,
        notAttemptedSince: cutoff,
      }))
    ) {
      continue;
    }

    try {
      // id で引き直す。控えた名前は古くなっていることがある。
      const current = await forgejoRequestOrNull<ForgejoRepository>(
        `/repositories/${entry.forgejoRepoId}`,
      );
      if (!current) {
        // 消えている。守る相手がいない。
        await deleteGitRepositoryRepair({ forgejoRepoId: entry.forgejoRepoId });
        fixed += 1;
        continue;
      }

      const owner = current.owner.login;
      if (await hasTemplates(owner, current.name)) {
        // 誰かが直した (同名での作り直しなど)。
        await deleteGitRepositoryRepair({ forgejoRepoId: entry.forgejoRepoId });
        fixed += 1;
        continue;
      }

      // 直せなければ中で読み取り専用にし、それも駄目なら控えを残して投げる。
      await repairTemplates(owner, current);
      await deleteGitRepositoryRepair({ forgejoRepoId: entry.forgejoRepoId });
      fixed += 1;
    } catch (error) {
      await recordGitRepositoryRepairAttempt({
        forgejoRepoId: entry.forgejoRepoId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }

  // 1 回分ではなく残っている総数。21 件目以降が残っていても 0 と報告しない。
  return { fixed, pending: await countGitRepositoryRepairs() };
}

/**
 * リポジトリを作り、Beutl 用の .gitattributes / .gitignore を最初のコミットに入れる。
 * .gitattributes が無いと素材が LFS に載らないので、作成と同時に置くのが要点。
 */
/** 管理者自身のログイン名。作成中のリポジトリを預かる所有者。 */
let adminUsername: string | null = null;

async function getAdminUsername(): Promise<string> {
  if (adminUsername) return adminUsername;
  const me = await forgejoRequest<{ login: string }>("/user");
  adminUsername = me.login;
  return me.login;
}

/**
 * 預かったままのリポジトリを畳む。
 *
 * 直前に自分の名前空間へ作ったもので、利用者はまだ見ることも触ることもできない。
 * ここで消すのは、他人のリポジトリを消す危険とは別の話。
 */
async function discardHolding(
  admin: string,
  repository: ForgejoRepository,
): Promise<void> {
  await forgejoRequest(
    `/repos/${encodeURIComponent(admin)}/${encodeURIComponent(repository.name)}`,
    { method: "DELETE", responseType: "none" },
  ).catch((error) => {
    console.error(
      `could not discard the holding repository ${admin}/${repository.name}`,
      error,
    );
  });
  await deleteGitRepositoryRepair({ forgejoRepoId: repository.id }).catch(
    () => undefined,
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
 * 作成後に読み取り専用へ倒す仕掛けも、既に入ってしまったものは戻せない。
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
    await repairTemplates(sudo, conflicting);
    return conflicting;
  }

  const admin = await getAdminUsername();
  let holding: ForgejoRepository;
  // 自分で作ったと言い切れるかどうか。曖昧な応答から拾った場合は畳まない。
  let owned = true;

  try {
    // Sudo を付けない = 管理者自身の名前空間に作る。
    holding = await forgejoRequest<ForgejoRepository>("/user/repos", {
      method: "POST",
      body: {
        name,
        description,
        // プライベート専用で運用する。Forgejo 側も FORCE_PRIVATE で固定している。
        private: true,
        auto_init: true,
        default_branch: "main",
      },
    });
  } catch (error) {
    if (error instanceof ForgejoError && error.isConflict) {
      // 管理者の名前空間で衝突した = 同じ名前の作成が今まさに走っている。
      // 利用者の名前空間は上で空だと確かめてあるので、待って直せばよい。
      throw new ForgejoError(
        409,
        "POST",
        "/user/repos",
        `a repository named ${name} is being created; try again`,
      );
    }
    // 502/504 など。作られたのか作られていないのかが分からない。管理者の
    // 名前空間を見て、在れば引き継ぐ。無ければそのまま投げる。
    const existing = await getRepository(admin, admin, name).catch(() => null);
    if (!existing) throw error;
    holding = existing;
    owned = false;
  }

  // 落ちても追えるように控える。この時点では利用者は触れないので push はされない
  // が、預かったまま残るのを見えなくしない。
  await queueRepair(admin, holding, "held for setup; not transferred yet");

  try {
    await commitTemplates(admin, name, holding.default_branch);
    await assertTemplatesAreCanonical(admin, name);
  } catch (error) {
    // 利用者はまだ触れない。自分で作ったものなら畳んでやり直させる方が良い。
    if (owned) await discardHolding(admin, holding);
    throw error;
  }

  try {
    // ここで初めて利用者のものになる。既定値は入り終わっている。
    // id は変わらない (実測)。
    const transferred = await forgejoRequest<ForgejoRepository>(
      `/repos/${encodeURIComponent(admin)}/${encodeURIComponent(name)}/transfer`,
      { method: "POST", body: { new_owner: sudo } },
    );
    await deleteGitRepositoryRepair({ forgejoRepoId: holding.id }).catch(
      () => undefined,
    );
    return transferred;
  } catch (error) {
    if (owned) await discardHolding(admin, holding);
    throw error;
  }
}

export async function renameRepository(
  sudo: string,
  owner: string,
  name: string,
  newName: string,
) {
  return await forgejoRequest<ForgejoRepository>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    {
      method: "PATCH",
      sudo,
      body: { name: newName },
    },
  );
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
