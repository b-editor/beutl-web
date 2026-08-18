/**
 * リポジトリ内のファイルパスを URL に載せるときのエンコード。
 *
 * Forgejo API へのリクエストと、画面が作る href の両方でこれを使う。片方だけ
 * エンコードしていると、名前に空白や `#` `?` `%` を含むファイルで行き先がずれる。
 * Beutl のプロジェクトは日本語や空白を含む名前になりやすいので実際に踏む。
 *
 * セグメント単位でエンコードするので、区切りの `/` はそのまま残る。
 */
export function encodeRepositoryPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/**
 * Next.js の dynamic route params は既にデコードされて渡ってくる。
 * ここで再度 decodeURIComponent すると `100%.txt` のような名前で URIError になるため、
 * 受け取り側は結合するだけにする。
 */
export function joinRouteSegments(segments: string[]): string {
  return segments.join("/");
}
