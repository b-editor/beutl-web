import { notFound } from "next/navigation";
import { formatBytes } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import {
  encodeRepositoryPath,
  FILE_TOO_LARGE,
  getRawFile,
  joinRouteSegments,
  parseLfsPointer,
} from "@beutl/forgejo";
import { Button } from "@beutl/ui/ui/button";
import { Download } from "lucide-react";
import { Breadcrumbs } from "../../breadcrumbs";
import { loadRepository } from "../../repository";

/** これを超えるテキストは表示せず、ダウンロードに誘導する。 */
const MAX_RENDERED_BYTES = 512 * 1024;

/**
 * NUL バイトが含まれていればテキストとして表示しない。
 * Forgejo の raw はデコード済みの文字列で返ってくるので、置換文字の混入でも判定する。
 */
function isProbablyBinary(content: string) {
  return content.includes("\u0000") || content.includes("\ufffd");
}

export default async function Page(props: {
  params: Promise<{
    lang: string;
    owner: string;
    repo: string;
    path: string[];
  }>;
}) {
  const { lang, owner, repo, path: segments } = await props.params;
  // Next の dynamic params は既にデコード済み。再度デコードすると
  // 100%.txt のような名前で URIError になる。
  const path = joinRouteSegments(segments);

  const { username } = await loadRepository(owner, repo);
  const { t } = await getTranslation(lang);

  // 表示上限を超えるものは読み込まずに弾く。LFS に載せていない巨大なバイナリが
  // あっても、判断のためだけにメモリへ載せない。
  const content = await getRawFile(username, owner, repo, path, undefined, {
    maxBytes: MAX_RENDERED_BYTES,
  });
  if (content === null) {
    notFound();
  }
  // 大きすぎて読まなかった場合。存在しないのとは違うので 404 にはせず、
  // ダウンロードの導線を出す。
  const tooLarge = content === FILE_TOO_LARGE;
  const text = content === FILE_TOO_LARGE ? "" : content;

  const base = `/${lang}/dashboard/repositories/${owner}/${repo}`;
  const parentPath = segments.slice(0, -1).join("/");
  const downloadUrl = `/api/git/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/media/${encodeRepositoryPath(path)}`;
  const pointer = tooLarge ? null : parseLfsPointer(text);

  return (
    <div className="flex flex-col gap-3">
      <Breadcrumbs
        base={base}
        path={parentPath ? `${parentPath}/${segments.at(-1)}` : path}
        repo={repo}
      />

      {pointer ? (
        // LFS 管理下のファイル。中身はポインタなので、メタ情報と取得口だけ出す。
        <div className="flex flex-col gap-3 rounded-lg border p-6">
          <p className="font-medium">{t("repositories:lfsFile")}</p>
          <p className="text-sm text-muted-foreground">
            {t("repositories:lfsFileDescription", {
              size: formatBytes(pointer.size),
              oid: pointer.oid.slice(0, 12),
            })}
          </p>
          <div>
            <Button asChild variant="outline">
              <a href={downloadUrl} download>
                <Download className="mr-2 h-4 w-4" />
                {t("repositories:download")}
              </a>
            </Button>
          </div>
        </div>
      ) : tooLarge || text.length > MAX_RENDERED_BYTES ? (
        <div className="flex flex-col gap-3 rounded-lg border p-6">
          <p className="text-sm text-muted-foreground">
            {t("repositories:fileTooLarge")}
          </p>
          <div>
            <Button asChild variant="outline">
              <a href={downloadUrl} download>
                <Download className="mr-2 h-4 w-4" />
                {t("repositories:download")}
              </a>
            </Button>
          </div>
        </div>
      ) : isProbablyBinary(text) ? (
        <div className="flex flex-col gap-3 rounded-lg border p-6">
          <p className="text-sm text-muted-foreground">
            {t("repositories:binaryFile")}
          </p>
          <div>
            <Button asChild variant="outline">
              <a href={downloadUrl} download>
                <Download className="mr-2 h-4 w-4" />
                {t("repositories:download")}
              </a>
            </Button>
          </div>
        </div>
      ) : (
        // .bep / .scene / .belm は整形済み JSON なので、そのまま等幅で読める。
        <div className="overflow-x-auto rounded-lg border">
          <pre className="p-4 text-xs leading-relaxed">
            <code>{text}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
