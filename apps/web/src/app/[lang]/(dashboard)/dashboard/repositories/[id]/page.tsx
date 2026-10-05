import { listRepositoryRefs, readRepositoryPath } from "@beutl/api/git/repository-browser";
import { RepositoryNotice } from "./repository-notice";
import { RepositoryHeader } from "./repository-header";
import { FileBrowser } from "./file-browser";
import { defaultRevision, loadRepository, requestedLocation } from "./repository-data";
import { repositoryHref } from "./links";

export default async function Page(props: {
  params: Promise<{ lang: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ lang, id }, query] = await Promise.all([props.params, props.searchParams]);
  const loaded = await loadRepository(id);
  if (loaded.status === "unavailable") return <RepositoryNotice lang={lang} kind="unavailable" />;
  const { repository, env, access } = loaded;
  const refs = await listRepositoryRefs(env, access);
  const requested = requestedLocation(query);
  const ref = requested.ref ?? defaultRevision(refs);
  const header = (commit?: string) => (
    <RepositoryHeader lang={lang} repository={repository} refs={refs} current={ref} commit={commit} tab="files" />
  );
  if (!ref) {
    return <div className="flex flex-col gap-6">{header()}<RepositoryNotice lang={lang} kind="empty" cloneUrl={repository.url} /></div>;
  }

  // A file's URL shows its directory with the file open in the preview.
  let view = await readRepositoryPath(env, access, ref, requested.path);
  let opened: string | undefined;
  if (view?.kind === "blob") {
    opened = view.path;
    view = await readRepositoryPath(env, access, view.commit, view.path.split("/").slice(0, -1).join("/"));
  }
  if (view?.kind !== "tree") {
    return (
      <div className="flex flex-col gap-6">
        {header()}
        <RepositoryNotice lang={lang} kind="notFound" rootHref={repositoryHref(lang, id, "files", refs.defaultBranch ? {} : { ref })} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      {header(view.commit)}
      <FileBrowser
        key={`${view.commit}:${view.path}`}
        lang={lang}
        repositoryId={id}
        repositoryName={repository.name}
        refName={ref}
        commit={view.commit}
        path={view.path}
        entries={view.entries}
        opened={opened}
      />
    </div>
  );
}
