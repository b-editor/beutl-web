/**
 * Git LFS のポインタファイル。
 *
 * Forgejo の contents / raw API は LFS 管理下のファイルについて実体ではなく
 * ポインタを返す。size もポインタ自身のバイト数になるため、実サイズを出したい
 * 画面ではポインタを読む必要がある。実体は media エンドポイントから取る。
 */
export type LfsPointer = {
  oid: string;
  size: number;
};

const POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
/** ポインタは仕様上 1KiB を超えない。これ以上を読み込んで判定する意味はない。 */
export const MAX_LFS_POINTER_BYTES = 1024;

/**
 * LFS ポインタなら中身を返し、そうでなければ null を返す。
 */
export function parseLfsPointer(content: string): LfsPointer | null {
  if (content.length > MAX_LFS_POINTER_BYTES) return null;
  if (!content.startsWith(POINTER_PREFIX)) return null;

  let oid: string | undefined;
  let size: number | undefined;

  for (const line of content.split("\n")) {
    const [key, value] = line.split(" ", 2);
    if (key === "oid" && value?.startsWith("sha256:")) {
      oid = value.slice("sha256:".length);
    } else if (key === "size") {
      const parsed = Number.parseInt(value ?? "", 10);
      if (Number.isFinite(parsed)) size = parsed;
    }
  }

  if (!oid || size === undefined) return null;
  return { oid, size };
}
