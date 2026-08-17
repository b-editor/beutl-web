import { getTranslation } from "@beutl/i18n";
import { authOrSignIn } from "@/lib/auth-guard";
import { getEntitlements } from "@beutl/api";
import { AiFeatureLinks } from "./components";

export const dynamic = "force-dynamic";

export default async function Page(props: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const { t } = await getTranslation(lang);
  const entitlements = await getEntitlements(session.user.id);

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
        canUseAi={entitlements.canUseAi}
        usagePercent={entitlements.balance.monthlyUsage.usedPercent}
        remainingPercent={entitlements.balance.monthlyUsage.remainingPercent}
        additionalCredits={entitlements.balance.additionalCredits}
      />
    </div>
  );
}
