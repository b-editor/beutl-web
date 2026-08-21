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
 * テンプレートのコミットに失敗した後始末。
 *
 * **削除はしない。** 外部で作られたリポジトリを消す判断は、こちらからは安全に
 * 下せない。作成の 201 と「作成直後の状態」を原子的に得る手段が無いので、控えた
 * SHA は既に誰かの push 後のものかもしれず、確かめてから DELETE するまでの間にも
 * 同じ隙間がある。空に見えるだけの誰かのリポジトリを消す危険を、テンプレートを
 * 入れ直す手間と引き換えにはできない。
 *
 * 代わりに足りないものを入れ直す。入れられなければ記録だけ残す。呼び出し元は
 * 既に別の例外を投げようとしていて、それを握り潰すと本来の失敗理由が消える。
 */
async function repairAfterTemplateFailure(
  sudo: string,
  repository: ForgejoRepository,
): Promise<void> {
  const name = repository.name;
  try {
    const current = await getRepository(sudo, sudo, name);
    if (!current || current.id !== repository.id) return;
    await commitTemplates(sudo, name, current.default_branch);
  } catch (error) {
    console.error(
      `${sudo}/${name} was created without .gitattributes and could not be ` +
        "repaired; media pushed to it will not use LFS. Creating it again " +
        "under the same name goes through the repair path.",
      error,
    );
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
      "to it will not use LFS. Creating the repository again under the same " +
      "name repairs it; if that keeps failing, check .gitattributes and " +
      ".gitignore by hand.",
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
 * 作成 API の成否が分からないときの後始末。
 *
 * 502 や 504 は「作られていない」とも「作られたが応答を落とした」とも取れる。
 * 同じ利用者が二重に押した場合や、再送が重なった場合も同じ見え方になる。
 * 削除で決着させると、他方が正しく作ったリポジトリを消してしまう。
 *
 * 代わりに、実在していてテンプレートが入っていなければ入れる。作ったのが自分でも
 * 他方でも、目的の状態 (.gitattributes のあるリポジトリ) に寄せられる。
 *
 * @returns 辻褄が合わせられたらそのリポジトリ、判断できなければ null。
 */
async function reconcileAfterAmbiguousCreate(
  sudo: string,
  name: string,
): Promise<ForgejoRepository | null> {
  try {
    const existing = await getRepository(sudo, sudo, name);
    if (!existing) return null;

    await commitTemplates(sudo, name, existing.default_branch);
    await assertTemplatesAreCanonical(sudo, name);
    return existing;
  } catch (error) {
    console.error(
      `could not reconcile ${sudo}/${name} after an ambiguous create; if it ` +
        "exists without .gitattributes, media pushed to it will not use LFS",
      error,
    );
    return null;
  }
}

/**
 * リポジトリを作り、Beutl 用の .gitattributes / .gitignore を最初のコミットに入れる。
 * .gitattributes が無いと素材が LFS に載らないので、作成と同時に置くのが要点。
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

    // 揃っていないなら、前回の作成が途中で終わったもの。ここで 409 にすると
    // 二度と直せる経路が無くなり、LFS の効かないリポジトリに push され続ける。
    // やり直しをそのまま修復として扱う。
    await commitTemplates(sudo, name, conflicting.default_branch);
    await assertTemplatesAreCanonical(sudo, name);
    return conflicting;
  }

  let repository: ForgejoRepository;
  try {
    repository = await forgejoRequest<ForgejoRepository>("/user/repos", {
      method: "POST",
      sudo,
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
    // 名前の衝突はそのまま返す。作られていないので畳むものもない。
    if (error instanceof ForgejoError && error.isConflict) {
      throw error;
    }
    // それ以外 (502/504 など) は、作られたのか作られていないのかが分からない。
    // ここで「在るから消す」をやると、同時に走った別のリクエストが正しく作った
    // リポジトリを巻き添えにする。消さずに、足りないものを足して辻褄を合わせる。
    const reconciled = await reconcileAfterAmbiguousCreate(sudo, name);
    if (reconciled) return reconciled;
    throw error;
  }

  try {
    await commitTemplates(sudo, name, repository.default_branch);
    // 201 の後、こちらが書く前に利用者が別の .gitattributes を push している
    // ことがある。その場合 commitTemplates は「ある」と見て何もしない。
    await assertTemplatesAreCanonical(sudo, name);
  } catch (error) {
    // .gitattributes の無いリポジトリを残すと、その後 push された素材が LFS に
    // 載らず、数 GiB の動画が普通の git オブジェクトとして入ってしまう。作成自体を
    // なかったことにして、ユーザーにやり直させる方がまだ良い。
    await repairAfterTemplateFailure(sudo, repository);
    throw error;
  }

  return repository;
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
