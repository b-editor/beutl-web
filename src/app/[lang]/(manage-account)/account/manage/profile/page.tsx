import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Form } from "./components";
import { getTranslation } from "@/app/i18n/server";

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

  const db = await prisma();
  const profile = await db.profile.findFirst({
    where: {
      userId: session.user.id,
    },
  });
  const socials = await db.socialProfile.findMany({
    where: {
      userId: session.user.id,
    },
    select: {
      value: true,
      provider: {
        select: {
          id: true,
          name: true,
          provider: true,
          urlTemplate: true,
        },
      },
    },
  });
  const { t } = await getTranslation(lang);

  return (
    <div>
      <h2 className="font-bold text-2xl">{t("account:profile.title")}</h2>
      <Form lang={lang} profile={profile} socials={socials} className="mt-4" />
    </div>
  );
}
