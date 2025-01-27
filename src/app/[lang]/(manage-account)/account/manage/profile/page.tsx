import { auth } from "@/auth";
import { prisma } from "@/prisma";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Form } from "./components";
import { getTranslation } from "@/app/i18n/server";

export default async function Page({
  params: { lang },
}: { params: { lang: string } }) {
  const session = await auth();
  if (!session?.user) {
    const url = headers().get("x-url") || `/${lang}`;
    redirect(`/${lang}/account/sign-in?returnUrl=${encodeURIComponent(url)}`);
  }

  const profile = await prisma.profile.findFirst({
    where: {
      userId: session.user.id,
    },
  });
  const socials = await prisma.socialProfile.findMany({
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
