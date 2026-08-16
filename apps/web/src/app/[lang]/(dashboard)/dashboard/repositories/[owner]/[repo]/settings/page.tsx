import { loadRepository } from "../repository";
import { SettingsForms } from "./forms";

export default async function Page(props: {
  params: Promise<{ lang: string; owner: string; repo: string }>;
}) {
  const { lang, owner, repo } = await props.params;
  const { repository } = await loadRepository(owner, repo);

  return (
    <SettingsForms
      lang={lang}
      owner={owner}
      repo={repo}
      description={repository.description}
    />
  );
}
