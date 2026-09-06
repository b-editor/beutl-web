import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { AiFeatureLinks } from "./feature-links";
import { countActiveAiJobs, getAiScreenState } from "./queries";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const { access, balance } = await getAiScreenState(session.user.id);
  const activeJobCount = access.canUseAi
    ? await countActiveAiJobs(session.user.id)
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{t("dashboard:ai.title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("dashboard:ai.description")}
        </p>
      </div>
      <AiFeatureLinks
        lang={lang}
        access={access}
        balance={balance}
        activeJobCount={activeJobCount}
      />
    </div>
  );
}
