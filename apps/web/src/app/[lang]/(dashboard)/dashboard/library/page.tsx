import { authOrSignIn } from "@/lib/auth-guard";
import { retrievePackages } from "./actions";
import { LibraryPackageCard } from "./package-card";
import { getTranslation } from "@beutl/i18n";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const { lang } = await props.params;

  const session = await authOrSignIn();
  const packages = await retrievePackages(session.user.id);
  const { t } = await getTranslation(lang);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold">{t("store:library")}</h1>
      {packages.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("dashboard:overview.noLibraryPackages")}
        </p>
      ) : (
        <div className="flex flex-wrap -mx-2">
          {packages.map((item) => (
            <LibraryPackageCard
              key={item.id}
              item={item}
              lang={lang}
              freeLabel={t("store:free")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
