import { auth } from "@/lib/better-auth";
import {
  getProfileByUserId,
  getSocialProfilesByUserId,
} from "@/lib/db/profile";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Form } from "./components";
import { getTranslation } from "@/app/i18n/server";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const params = await props.params;

  const {
    lang
  } = params;

  const headersList = await headers();
  const session = await auth.api.getSession({ headers: headersList });
  if (!session?.user) {
    const url = headersList.get("x-url") || `/${lang}`;
    redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(url)}`);
  }

  const profile = await getProfileByUserId(session.user.id);
  const socials = await getSocialProfilesByUserId(session.user.id);
  const { t } = await getTranslation(lang);

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:profile.title")}</h2>
      <Form lang={lang} profile={profile} socials={socials} className="mt-4" />
    </div>
  );
}
