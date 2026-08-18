import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslation } from "@beutl/i18n";
import { formatBytes } from "@beutl/core";
import {
  encodeRepositoryPath,
  listContents,
  resolveContentSizes,
} from "@beutl/forgejo";
import {
  File,
  FileAudio,
  FileImage,
  FileVideo,
  Folder,
  Type,
} from "lucide-react";
import { loadRepository } from "./repository";
import { Breadcrumbs } from "./breadcrumbs";

/**
 * アイコンの出し分けだけに使う対応表。GITATTRIBUTES_TEMPLATE で LFS に載せている
 * 拡張子を全て網羅する (漏れると素材が汎用ファイルのアイコンで並ぶ)。
 *
 * 表示にしか影響しない。LFS ポインタの実サイズ解決は拡張子ではなくファイルサイズで
 * 判定するので (resolveContentSizes)、ここに漏れがあってもサイズは正しく出る。
 */
const ICONS_BY_EXTENSION = new Map(
  Object.entries({
    "mp4 mov mkv webm avi m4v": FileVideo,
    "wav mp3 flac aac m4a ogg": FileAudio,
    "png jpg jpeg gif webp bmp tif tiff psd exr": FileImage,
    "ttf otf ttc woff woff2": Type,
  }).flatMap(([extensions, icon]) =>
    extensions.split(" ").map((extension) => [extension, icon] as const),
  ),
);

function iconFor(name: string) {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return ICONS_BY_EXTENSION.get(extension) ?? File;
}

export async function FileTree({
  lang,
  owner,
  repo,
  path,
}: {
  lang: string;
  owner: string;
  repo: string;
  path: string;
}) {
  const { username, repository } = await loadRepository(owner, repo);
  const { t } = await getTranslation(lang);
  const base = `/${lang}/dashboard/repositories/${owner}/${repo}`;

  if (repository.empty) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border px-6 py-16 text-center">
        <p className="font-medium">{t("repositories:emptyRepository")}</p>
        <p className="text-sm text-muted-foreground">
          {t("repositories:emptyRepositoryDescription")}
        </p>
      </div>
    );
  }

  const entries = await listContents(username, owner, repo, path);
  if (entries === null) {
    notFound();
  }

  // ディレクトリを先に、その中で名前順。Forgejo の返す順序に依存しない。
  const sorted = [...entries].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // LFS 管理下のファイルはポインタのサイズが返るので、実サイズに置き換える。
  const sizes = await resolveContentSizes(username, owner, repo, sorted);

  return (
    <div className="flex flex-col gap-3">
      <Breadcrumbs base={base} path={path} repo={repo} />
      <ul className="divide-y rounded-lg border">
        {sorted.map((entry) => {
          const Icon = entry.type === "dir" ? Folder : iconFor(entry.name);
          // 名前に空白や # % が入りうるので、href に載せる前にエンコードする。
          const encoded = encodeRepositoryPath(entry.path);
          const href =
            entry.type === "dir"
              ? `${base}/tree/${encoded}`
              : `${base}/blob/${encoded}`;
          const size = sizes.get(entry.path);
          return (
            <li key={entry.path}>
              <Link
                href={href}
                className="flex items-center justify-between gap-3 px-4 py-2 hover:bg-muted/50"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm">{entry.name}</span>
                </span>
                {size !== undefined && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(size)}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
