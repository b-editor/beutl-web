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
    if (batch.length < MAX_PAGE_SIZE) return all;
  }

  console.error(
    `listRepositories stopped at ${MAX_REPOSITORY_PAGES} pages for ${sudo}; the list may be incomplete`,
  );
  return all;
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

/**
 * テンプレートの入っていないリポジトリを消す。
 *
 * 作成そのものは成功していて応答だけ失われた場合もここに来るので、実在を
 * 確かめてから消す。消せなかったら投げずに記録だけ残す。呼び出し元は既に別の
 * 例外を投げようとしていて、それを握り潰すと本来の失敗理由が消えるため。
 */
async function rollbackPartialRepository(sudo: string, name: string) {
  try {
    const existing = await getRepository(sudo, sudo, name);
    if (!existing) return;
    await deleteRepository(sudo, sudo, name);
  } catch (error) {
    console.error(
      `failed to roll back the half-created repository ${sudo}/${name}; ` +
        "it has no .gitattributes, so media pushed to it will not use LFS",
      error,
    );
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
    // 応答だけを取りこぼした場合、サーバー側には .gitattributes の無いリポジトリが
    // 出来ている。作成が成功していたかを確かめてから畳む。
    await rollbackPartialRepository(sudo, name);
    throw error;
  }

  try {
    await forgejoRequest(
      `/repos/${encodeURIComponent(sudo)}/${encodeURIComponent(name)}/contents`,
      {
        method: "POST",
        sudo,
        body: {
          branch: repository.default_branch,
          message: "Add Beutl project defaults",
          files: [
            {
              operation: "create",
              path: ".gitattributes",
              content: toBase64(GITATTRIBUTES_TEMPLATE),
            },
            {
              operation: "create",
              path: ".gitignore",
              content: toBase64(GITIGNORE_TEMPLATE),
            },
          ],
        },
      },
    );
  } catch (error) {
    // .gitattributes の無いリポジトリを残すと、その後 push された素材が LFS に
    // 載らず、数 GiB の動画が普通の git オブジェクトとして入ってしまう。作成自体を
    // なかったことにして、ユーザーにやり直させる方がまだ良い。
    await rollbackPartialRepository(sudo, name);
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
