import { findGitAccountByUserId } from "@beutl/db";
import { forgejoRequest } from "./client";
import { ForgejoError } from "./errors";

/**
 * Beutl アカウントの削除に合わせて Forgejo 側を消す。
 *
 * 端末に配った git トークンは Forgejo が直接認証する。git と LFS の通信は Caddy が
 * 素通しするので beutl-web を経由せず、こちらのレコードを消しても push は通り続ける。
 *
 * トークンだけを止める手段が無い。失効は対象ユーザーの Basic 認証を要求し、管理
 * トークンでは 401 になる。無効化のフラグも効かず、`active: false` と
 * `prohibit_login: true` はどちらを立てても git のトークン認証を素通しする
 * (Forgejo 16.0.2 で実測。push は 200 のままだった)。確実に断てるのはユーザーごと
 * 消すことだけで、これはリポジトリとトークンも一緒に落とす。
 *
 * 必ず Beutl 側のレコードより先に消す。逆順にすると、Forgejo の削除に失敗したときに
 * 対応表だけが失われ、誰のものか分からないユーザーと生きたトークンが残る。
 *
 * @returns 消すものがあれば true、対応表に無ければ false。
 */
export async function deleteGitAccount(userId: string): Promise<boolean> {
  const account = await findGitAccountByUserId({ userId });
  if (!account) {
    // Git を一度も使っていないユーザー。Forgejo には何も無い。
    return false;
  }

  try {
    await forgejoRequest(
      `/admin/users/${encodeURIComponent(account.forgejoUsername)}`,
      {
        method: "DELETE",
        // リポジトリを持っているユーザーは purge を付けないと 422 で拒まれる。
        searchParams: { purge: true },
        responseType: "none",
      },
    );
  } catch (error) {
    // 既に消えているなら目的は達している。再試行で 404 になるのは正常な経路。
    if (error instanceof ForgejoError && error.isNotFound) {
      return true;
    }
    throw error;
  }

  return true;
}
