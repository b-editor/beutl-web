import { throwIfUnauth } from "@/lib/auth-guard";
import { isOwnedBy, resolveGitUsername } from "@/lib/git-account";
import { fetchMedia, joinRouteSegments } from "@beutl/forgejo";

/**
 * Forgejo 上のファイル実体をブラウザへ中継する。
 *
 * Forgejo の API は管理トークンと共有シークレットを要求するので、ブラウザから
 * 直接は叩けない。ここでセッションを検証し、本人のリポジトリに限って
 * レスポンスをそのまま流す (LFS の実体は数 GiB になりうるため読み切らない)。
 */
export async function GET(
  request: Request,
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

  // Next の dynamic params は既にデコード済み。再度デコードしない。
  const filePath = joinRouteSegments(path);
  // 素材は数 GiB になる。Range を渡さないと、回線が切れるたびに先頭から取り直しに
  // なり、途中から再生することもできない。Forgejo の media は 206 を返せる。
  const upstream = await fetchMedia(username, owner, repo, filePath, undefined, {
    forwardHeaders: {
      Range: request.headers.get("Range"),
      "If-Range": request.headers.get("If-Range"),
    },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  // 部分応答の解釈に必要なものは、そのまま渡さないとブラウザが繋ぎ直せない。
  for (const name of [
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "Last-Modified",
    "ETag",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set(
    "Content-Disposition",
    `attachment; filename*=UTF-8''${encodeURIComponent(path.at(-1) ?? "download")}`,
  );
  // 非公開リポジトリの中身なので、共有キャッシュには載せない。
  headers.set("Cache-Control", "private, no-store");

  // 206 をそのまま返す。200 に潰すと、ブラウザは部分データを全体だと思い込む。
  return new Response(upstream.body, { status: upstream.status, headers });
}
