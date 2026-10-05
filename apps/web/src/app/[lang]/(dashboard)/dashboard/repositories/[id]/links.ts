// Dashboard URLs of a repository view; the ref and path live in the query so
// any file name round-trips without escaping rules of its own.

export function repositoryHref(lang: string, id: string, view: "files" | "commits", query: Record<string, string | undefined> = {}) {
  const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => !!entry[1]));
  const base = `/${lang}/dashboard/repositories/${id}${view === "commits" ? "/commits" : ""}`;
  return search.size ? `${base}?${search}` : base;
}

/** Where the owner's browser streams one file of a commit. */
export function repositoryContentUrl(id: string, commit: string, path: string) {
  return `/api/repositories/${id}/content?${new URLSearchParams({ ref: commit, path })}`;
}

export const shortOid = (oid: string) => oid.slice(0, 7);
