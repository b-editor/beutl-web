import { auth } from "@/auth";
import { drizzle } from "@/drizzle";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Form } from "./components";
import { getTranslation } from "@/app/i18n/server";
import { profile, socialProfile, socialProfileProvider } from "@/drizzle/schema";
import { eq } from "drizzle-orm";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  const session = await auth();
  if (!session?.user) {
    const url = (await headers()).get("x-url") || `/${lang}`;
    redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(url)}`);
  }

  const db = await drizzle();
  const profileResult = await db
    .select()
    .from(profile)
    .where(eq(profile.userId, session.user.id!))
    .limit(1);
  
  const socials = await db
    .select({
      value: socialProfile.value,
      provider: {
        id: socialProfileProvider.id,
        name: socialProfileProvider.name,
        provider: socialProfileProvider.provider,
        urlTemplate: socialProfileProvider.urlTemplate,
      },
    })
    .from(socialProfile)
    .innerJoin(socialProfileProvider, eq(socialProfile.providerId, socialProfileProvider.id))
    .where(eq(socialProfile.userId, session.user.id!));
  const { t } = await getTranslation(lang);

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:profile.title")}</h2>
      <Form lang={lang} profile={profileResult[0]} socials={socials as any} className="mt-4" />
    </div>
  );
}
