import {
  buildCloneUrl,
  forgejoFetch,
  forgejoRequest,
  forgejoRequestOrNull,
} from "./client";
import { MAX_LFS_POINTER_BYTES, parseLfsPointer } from "./lfs";
import { GITATTRIBUTES_TEMPLATE, GITIGNORE_TEMPLATE } from "./templates";
import type {
  ForgejoBranch,
  ForgejoCommit,
  ForgejoContentsEntry,
  ForgejoRepository,
} from "./types";

/** Forgejo のページングの上限。 */
const MAX_PAGE_SIZE = 50;

function encodePath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** UTF-8 文字列を base64 に。btoa は Latin-1 しか受け付けないため経由する。 */
function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function listRepositories(
  sudo: string,
  { page = 1, limit = MAX_PAGE_SIZE }: { page?: number; limit?: number } = {},
) {
  return await forgejoRequest<ForgejoRepository[]>("/user/repos", {
    sudo,
    searchParams: { page, limit },
  });
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
  const repository = await forgejoRequest<ForgejoRepository>("/user/repos", {
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
  const url = path ? `${base}/${encodePath(path)}` : base;
  const result = await forgejoRequestOrNull<
    ForgejoContentsEntry[] | ForgejoContentsEntry
  >(url, { sudo, searchParams: { ref } });

  if (result === null) return null;
  return Array.isArray(result) ? result : [result];
}

/**
 * ファイルの中身をそのまま取る。LFS 管理下ならポインタが返る
 * (実体が要るときは buildMediaUrl の方を使う)。
 */
export async function getRawFile(
  sudo: string,
  owner: string,
  name: string,
  path: string,
  ref?: string,
) {
  return await forgejoRequestOrNull<string>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${encodePath(path)}`,
    { sudo, searchParams: { ref }, responseType: "text" },
  );
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
      getRawFile(sudo, owner, name, entry.path, ref).catch(() => null),
    ),
  );

  resolvable.forEach((entry, index) => {
    const content = contents[index];
    const pointer = content === null ? null : parseLfsPointer(content);
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
) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  return await forgejoFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/media/${encodePath(path)}${query}`,
    { sudo },
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
