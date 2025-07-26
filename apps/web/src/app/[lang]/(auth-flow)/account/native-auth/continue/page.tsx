import { getTranslation } from "@/app/i18n/server";
import { auth } from "@/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function Page(
  props: { searchParams: Promise<{ returnUrl: string }>; params: Promise<{ lang: string }> }
) {
  const params = await props.params;

  const {
    lang
  } = params;

  const searchParams = await props.searchParams;

  const {
    returnUrl
  } = searchParams;

  const session = await auth();
  if (!session?.user) {
    redirect(
      `/${lang}/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`,
    );
  }
  const user = session.user;
  const { t } = await getTranslation(lang);

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
          <Image
            width={40}
            height={40}
            className="w-10 h-10 align-bottom"
            src="/img/logo_dark.svg"
            alt="Logo"
          />
          <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{t("auth:confirmation")}</CardTitle>
            <CardDescription>{t("auth:doYouWantToContinue")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full flex gap-4">
              <Avatar className="w-12 h-12">
                <AvatarFallback>
                  {user.email?.charAt(0)?.toUpperCase()}
                </AvatarFallback>
                {user.image && (
                  <AvatarImage src={user.image} alt="Profile image" />
                )}
              </Avatar>
              <div className="flex flex-col">
                <p className="font-bold">{user.name}</p>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
            </div>
          </CardContent>
          <CardFooter className="block">
            <Button className="w-full" asChild>
              <Link href={returnUrl}>{t("continue")}</Link>
            </Button>
            <Link
              href={`/${lang}/account/native-auth/sign-up?returnUrl=${encodeURIComponent(returnUrl)}`}
              prefetch={false}
              className="text-sm font-medium inline-block mt-6"
            >
              {t("auth:useAnotherAccount")}
            </Link>
          </CardFooter>
        </Card>
        <Link
          className="ml-auto text-sm absolute top-full right-0 translate-y-4"
          href={`/${lang}/docs/privacy`}
        >
          {t("privacy")}
        </Link>
      </div>
    </div>
  );
}
