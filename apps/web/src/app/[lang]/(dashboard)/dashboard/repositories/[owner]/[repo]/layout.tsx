import Link from "next/link";
import { getTranslation } from "@beutl/i18n";
import { formatBytes } from "@beutl/core";
import { ChevronLeft } from "lucide-react";
import { CloneUrl } from "./clone-url";
import { RepositoryTabs } from "./tabs";
import { loadRepository } from "./repository";

export default async function Layout(props: {
  children: React.ReactNode;
  params: Promise<{ lang: string; owner: string; repo: string }>;
}) {
  const { lang, owner, repo } = await props.params;
  const { repository } = await loadRepository(owner, repo);
  const { t } = await getTranslation(lang);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Link
          href={`/${lang}/dashboard/repositories`}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          {t("repositories:backToRepositories")}
        </Link>

        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-2xl font-bold">{repository.name}</h1>
          <span className="text-sm text-muted-foreground">
            {formatBytes(repository.size * 1024)}
          </span>
        </div>
        {repository.description && (
          <p className="text-sm text-muted-foreground">
            {repository.description}
          </p>
        )}

        <CloneUrl lang={lang} url={repository.clone_url} />
      </div>

      <RepositoryTabs lang={lang} owner={owner} repo={repo} />

      {props.children}
    </div>
  );
}
