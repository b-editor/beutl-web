import { authOrSignIn } from "@/lib/auth-guard";
import { retrieveRepositories } from "./actions";
import { RepositoryManager } from "./repository-manager";

export default async function Page({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  const session = await authOrSignIn();
  const result = await retrieveRepositories();
  return <RepositoryManager lang={lang} userId={session.user.id} initialResult={result} />;
}
