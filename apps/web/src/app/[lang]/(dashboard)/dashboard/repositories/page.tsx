import Link from "next/link";
import { authOrSignIn } from "@/lib/auth-guard";
import { resolveGitUsername } from "@/lib/git-account";
import { formatBytes } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import {
  MAX_CREDENTIALS_PER_USER,
  listGitCredentials,
  listRepositories,
} from "@beutl/forgejo";
import { Alert, AlertDescription, AlertTitle } from "@beutl/ui/ui/alert";
import { GitBranch } from "lucide-react";
import { CreateRepositoryDialog } from "./create-dialog";
import { CredentialsCard } from "./credentials-card";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);

  const username = await resolveGitUsername(session.user.id);
  if (!username) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold">{t("repositories:title")}</h1>
        <Alert variant="destructive">
          <AlertTitle>{t("repositories:title")}</AlertTitle>
          <AlertDescription>
            {t("repositories:errors.notConfigured")}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const [repositories, credentials] = await Promise.all([
    listRepositories(username),
    listGitCredentials(session.user.id),
  ]);
  // リポジトリの size は KiB 単位で、LFS に載せた素材も含む (保存先が S3 でも同じ)。
  // 同名だが contents API のエントリの size とは別物で、あちらは LFS ファイルに対して
  // ポインタのバイト数を返す (resolveContentSizes が実サイズに直す)。
  const totalBytes = repositories.reduce(
    (total, repository) => total + repository.size * 1024,
    0,
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">{t("repositories:title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("repositories:description")}
          </p>
        </div>
        <CreateRepositoryDialog lang={lang} />
      </div>

      {repositories.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border px-6 py-16 text-center">
          <GitBranch className="h-8 w-8 text-muted-foreground" />
          <p className="font-medium">{t("repositories:empty")}</p>
          <p className="text-sm text-muted-foreground">
            {t("repositories:emptyDescription")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            {t("repositories:usage", {
              count: repositories.length,
              size: formatBytes(totalBytes),
            })}
          </p>
          <ul className="divide-y rounded-lg border">
            {repositories.map((repository) => (
              <li key={repository.id}>
                <Link prefetch={false}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 hover:bg-muted/50"
                  href={`/${lang}/dashboard/repositories/${repository.owner.login}/${repository.name}`}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">
                      {repository.name}
                    </span>
                    {repository.description && (
                      <span className="truncate text-sm text-muted-foreground">
                        {repository.description}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-4 text-sm text-muted-foreground">
                    <span>{formatBytes(repository.size * 1024)}</span>
                    <time dateTime={repository.updated_at}>
                      {new Date(repository.updated_at).toLocaleDateString(lang)}
                    </time>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <CredentialsCard
        lang={lang}
        username={username}
        limit={MAX_CREDENTIALS_PER_USER}
        // Date はクライアントコンポーネントにそのまま渡せないので ISO 文字列にする。
        credentials={credentials.map((credential) => ({
          ...credential,
          createdAt: credential.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
