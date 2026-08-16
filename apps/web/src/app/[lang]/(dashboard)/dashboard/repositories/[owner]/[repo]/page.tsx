import { FileTree } from "./file-tree";

export default async function Page(props: {
  params: Promise<{ lang: string; owner: string; repo: string }>;
}) {
  const { lang, owner, repo } = await props.params;
  return <FileTree lang={lang} owner={owner} repo={repo} path="" />;
}
