import { GitCommitHorizontal } from "lucide-react";
import { listRepositoryCommits, listRepositoryRefs } from "@beutl/api/git/repository-browser";
import { formatDateTime } from "@beutl/core";
import { getTranslation } from "@beutl/i18n";
import { RepositoryNotice } from "../repository-notice";
import { RepositoryHeader } from "../repository-header";
import { defaultRevision, loadRepository, requestedLocation } from "../repository-data";
import { repositoryHref, shortOid } from "../links";
import { PendingArea, PendingLink } from "../navigation";

export default async function Page(props: {
  params: Promise<{ lang: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ lang, id }, query] = await Promise.all([props.params, props.searchParams]);
  const { t } = await getTranslation(lang);
  const loaded = await loadRepository(id);
  if (loaded.status === "unavailable") return <RepositoryNotice lang={lang} kind="unavailable" />;
  const { repository, env, access } = loaded;
  const refs = await listRepositoryRefs(env, access);
  const requested = requestedLocation(query);
  const ref = requested.ref ?? defaultRevision(refs);
  const header = <RepositoryHeader lang={lang} repository={repository} refs={refs} current={ref} tab="commits" />;
  if (!ref) {
    return <div className="flex flex-col gap-6">{header}<RepositoryNotice lang={lang} kind="empty" cloneUrl={repository.url} /></div>;
  }
  const page = await listRepositoryCommits(env, access, ref, requested.cursor);
  if (!page) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <RepositoryNotice lang={lang} kind="notFound" rootHref={repositoryHref(lang, id, "commits")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {header}
      <PendingArea>
        <ol className="divide-y rounded-md border" aria-label={t("dashboard:repositories.browser.commits")}>
          {page.commits.map((commit) => {
            const [subject, ...body] = commit.message.trim().split("\n");
            return (
              <li key={commit.oid} className="flex items-start gap-3 px-4 py-3">
                <GitCommitHorizontal className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="break-words font-medium">{subject}</p>
                  {body.join("\n").trim() !== "" && (
                    <p className="line-clamp-2 whitespace-pre-line break-words text-sm text-muted-foreground">{body.join("\n").trim()}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("dashboard:repositories.browser.committedBy", {
                      name: commit.authorName,
                      date: formatDateTime(commit.authoredAt, lang),
                      interpolation: { escapeValue: false },
                    })}
                  </p>
                </div>
                <PendingLink
                  href={repositoryHref(lang, id, "files", { ref: commit.oid })}
                  className="shrink-0 rounded-md border px-2 py-1 font-mono text-xs hover:bg-accent"
                  title={t("dashboard:repositories.browser.browseCommit")}
                >
                  {shortOid(commit.oid)}
                </PendingLink>
              </li>
            );
          })}
        </ol>
      </PendingArea>
      <div className="flex justify-between gap-2">
        {requested.cursor ? (
          <PendingLink href={repositoryHref(lang, id, "commits", { ref })} className="text-sm underline underline-offset-4">
            {t("dashboard:repositories.browser.newestCommits")}
          </PendingLink>
        ) : <span />}
        {page.next && (
          <PendingLink href={repositoryHref(lang, id, "commits", { ref, cursor: page.next })} className="text-sm underline underline-offset-4">
            {t("dashboard:repositories.browser.olderCommits")}
          </PendingLink>
        )}
      </div>
    </div>
  );
}
