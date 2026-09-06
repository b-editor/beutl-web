import { authOrSignIn } from "@/lib/auth-guard";
import {
  getDb,
  getProfileByUserId,
  getSocialProfilesByUserId,
} from "@beutl/db";
import { Form } from "./components";
import { getTranslation } from "@beutl/i18n";

export default async function Page(props: { params: Promise<{ lang: string }> }) {
  const { lang } = await props.params;
  const session = await authOrSignIn();
  const prisma = await getDb();
  const [profile, socials, { t }] = await Promise.all([
    getProfileByUserId(session.user.id, prisma),
    getSocialProfilesByUserId(session.user.id, prisma),
    getTranslation(lang),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-bold">{t("account:profile.title")}</h1>
      <Form lang={lang} profile={profile} socials={socials} className="mt-4" />
    </div>
  );
}
