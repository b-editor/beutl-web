import { throwIfUnauth } from "@/lib/auth-guard";
import { isOwnedBy, resolveGitUsername } from "@/lib/git-account";
import { fetchMedia } from "@beutl/forgejo";

/**
 * Forgejo 上のファイル実体をブラウザへ中継する。
 *
 * Forgejo の API は管理トークンと共有シークレットを要求するので、ブラウザから
 * 直接は叩けない。ここでセッションを検証し、本人のリポジトリに限って
 * レスポンスをそのまま流す (LFS の実体は数 GiB になりうるため読み切らない)。
 */
export async function GET(
  _request: Request,
  context: {
    params: Promise<{ owner: string; repo: string; path: string[] }>;
  },
) {
  const session = await throwIfUnauth();
  const { owner, repo, path } = await context.params;

  const username = await resolveGitUsername(session.user.id);
  if (!username || !isOwnedBy(owner, username)) {
    return new Response("Not Found", { status: 404 });
  }

  const filePath = path.map(decodeURIComponent).join("/");
  const upstream = await fetchMedia(username, owner, repo, filePath);
  if (!upstream.ok || !upstream.body) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  const contentType = upstream.headers.get("Content-Type");
  const contentLength = upstream.headers.get("Content-Length");
  if (contentType) headers.set("Content-Type", contentType);
  if (contentLength) headers.set("Content-Length", contentLength);
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(path.at(-1) ?? "download")}`,
  );
  // 非公開リポジトリの中身なので、共有キャッシュには載せない。
  headers.set("Cache-Control", "private, no-store");

  return new Response(upstream.body, { status: 200, headers });
}
