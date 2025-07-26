import { getTranslation } from "@/app/i18n/server";
import { Navigation } from "./components";
import { auth } from "@/auth";
import NavBar from "@/components/nav-bar";
import { Button } from "@/components/ui/button";
import { UserCircle } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function Layout(
  props: {
    children: React.ReactNode;
    params: Promise<{
      lang: string;
    }>;
  }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const {
    children
  } = props;

  const session = await auth();
  const url = (await headers()).get("x-url") || "/";
  if (!session) {
    const searchParams = new URLSearchParams();
    searchParams.set("returnUrl", url);
    redirect(`/account/sign-in?${searchParams.toString()}`);
  }
  const { t } = await getTranslation(lang);

  return (
    <div>
      <NavBar lang={lang} />
      <div className="max-w-7xl mx-auto pt-4 md:pt-12 px-4 md:px-[52px]">
        <div className="mb-6 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <UserCircle className="w-12 h-12" />
            <span>{session.user?.name ?? session.user?.email}</span>
          </div>
          <Link href="/account/sign-out" legacyBehavior passHref>
            <Button variant="outline">{t("signOut")}</Button>
          </Link>
        </div>
        <div className="flex flex-col md:grid md:grid-cols-[max-content_1fr] gap-6 items-start">
          <Navigation lang={lang} />
          <div className="w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}
