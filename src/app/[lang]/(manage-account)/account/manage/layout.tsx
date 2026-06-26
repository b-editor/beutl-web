import { getTranslation } from "@/app/i18n/server";
import { Navigation } from "./components";
import { authOrSignIn } from "@/lib/auth-guard";
import NavBar from "@/components/nav-bar";
import { Button } from "@/components/ui/button";
import { UserCircle } from "lucide-react";
import Link from "next/link";

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

  const session = await authOrSignIn();
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
          <Button variant="outline" asChild>
            <Link href={`/${lang}/account/sign-out`}>
              {t("signOut")}
            </Link>
          </Button>
        </div>
        <div className="flex flex-col md:grid md:grid-cols-[max-content_1fr] gap-6 items-start">
          <Navigation lang={lang} />
          <div className="w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}
