import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { authOrSignIn } from "@/lib/auth-guard";
import { isOwnedBy, resolveGitUsername } from "@/lib/git-account";
import { getRepository } from "@beutl/forgejo";
import type { ForgejoRepository } from "@beutl/forgejo";

export type RepositoryContext = {
  username: string;
  repository: ForgejoRepository;
};

/**
 * URL の owner/repo を検証してリポジトリを読む。
 *
 * layout と page がそれぞれ呼ぶので React の cache でリクエスト単位に 1 回へまとめる。
 * 他人の owner や存在しないリポジトリは 404 に落とす。
 */
export const loadRepository = cache(
  async (owner: string, repo: string): Promise<RepositoryContext> => {
    const session = await authOrSignIn();
    const username = await resolveGitUsername(session.user.id);
    if (!username || !isOwnedBy(owner, username)) {
      notFound();
    }

    const repository = await getRepository(username, owner, repo);
    if (!repository) {
      notFound();
    }

    return { username, repository };
  },
);
