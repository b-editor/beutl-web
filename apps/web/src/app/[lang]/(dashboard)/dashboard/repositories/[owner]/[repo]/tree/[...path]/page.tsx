import { joinRouteSegments } from "@beutl/forgejo";
import { FileTree } from "../../file-tree";

export default async function Page(props: {
  params: Promise<{ lang: string; owner: string; repo: string; path: string[] }>;
}) {
  const { lang, owner, repo, path } = await props.params;
  return (
    <FileTree
      lang={lang}
      owner={owner}
      repo={repo}
      // Next の dynamic params は既にデコード済み。ここで再度デコードしない。
      path={joinRouteSegments(path)}
    />
  );
}
