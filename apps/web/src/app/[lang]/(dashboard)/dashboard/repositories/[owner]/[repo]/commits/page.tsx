import { getTranslation } from "@beutl/i18n";
import { listCommits } from "@beutl/forgejo";
import { loadRepository } from "../repository";

export default async function Page(props: {
  params: Promise<{ lang: string; owner: string; repo: string }>;
}) {
  const { lang, owner, repo } = await props.params;
  const { username } = await loadRepository(owner, repo);
  const { t } = await getTranslation(lang);

  const commits = await listCommits(username, owner, repo);

  if (commits.length === 0) {
    return (
      <div className="rounded-lg border px-6 py-16 text-center text-sm text-muted-foreground">
        {t("repositories:noCommits")}
      </div>
    );
  }

  return (
    <ul className="divide-y rounded-lg border">
      {commits.map((commit) => {
        // コミットメッセージの 1 行目だけを見出しに使う。
        const subject = commit.commit.message.split("\n", 1)[0];
        return (
          <li
            key={commit.sha}
            className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3"
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium">{subject}</span>
              <span className="text-xs text-muted-foreground">
                {commit.commit.author.name}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <code>{commit.sha.slice(0, 7)}</code>
              <time dateTime={commit.commit.author.date}>
                {new Date(commit.commit.author.date).toLocaleString(lang)}
              </time>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
