import "server-only";
import { ensureGitAccount, isForgejoConfigured } from "@beutl/forgejo";

/**
 * ログイン中のユーザーに対応する Forgejo ユーザー名を返す。
 * まだ Forgejo 側にアカウントが無ければここで作る。
 *
 * Git サービスが未設定の環境 (ローカルで FORGEJO_* を入れていない場合など) では
 * 例外を投げずに null を返し、画面側で案内を出せるようにしている。
 */
export async function resolveGitUsername(
  userId: string,
): Promise<string | null> {
  if (!isForgejoConfigured()) return null;
  const account = await ensureGitAccount(userId);
  return account.forgejoUsername;
}

/**
 * URL の owner セグメントが本人のものかを確かめる。
 *
 * リポジトリは全て非公開で、Forgejo 側も Sudo 代理実行で本人の権限しか使わないため
 * 他人のリポジトリは 404 になる。ここでの検査はその手前で弾くためのもので、
 * 「他人の owner を指定した URL」を早めに 404 に落とす。
 */
export function isOwnedBy(owner: string, username: string): boolean {
  return owner.toLowerCase() === username.toLowerCase();
}
