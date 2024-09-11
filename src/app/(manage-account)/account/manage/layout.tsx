import { auth } from "@/auth";
import NavBar from "@/components/nav-bar";
import { Button } from "@/components/ui/button";
import { NavigationMenu, NavigationMenuItem, NavigationMenuLink, NavigationMenuList, navigationMenuTriggerStyle } from "@/components/ui/navigation-menu";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CircleUser, UserCircle } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  const url = headers().get("x-url") || "/";
  if (!session) {
    const searchParams = new URLSearchParams();
    searchParams.set("returnUrl", url);
    redirect(`/account/sign-in?${searchParams.toString()}`);
  }
  const slug = new URL(url).pathname.split("/")[3];
  console.log(new URL(url).pathname.split("/"));

  return (
    <div>
      <NavBar />
      <div className="max-w-7xl mx-auto pt-4 md:pt-12 px-4 md:px-[52px]">
        <div className="mb-6 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <UserCircle className="w-12 h-12" />
            <span>{session.user?.name ?? session.user?.email}</span>
          </div>
          <Link href="/account/sign-out" legacyBehavior passHref>
            <Button variant="outline">
              サインアウト
            </Button>
          </Link>
        </div>
        <div className="flex flex-col md:grid md:grid-cols-[max-content,1fr] gap-2">
          <ToggleGroup type="single" className="flex-col items-stretch md:min-w-72">
            <Link href="/account/manage/profile" legacyBehavior passHref>
              <ToggleGroupItem value="profile" aria-label="Toggle bold" className="justify-start">
                <CircleUser className="w-4 h-4 mr-2" />
                プロフィール
              </ToggleGroupItem>
            </Link>
            <Link href="/account/manage/email" legacyBehavior passHref>
              <ToggleGroupItem value="email" aria-label="Toggle bold" className="justify-start">
                <CircleUser className="w-4 h-4 mr-2" />
                メールアドレス
              </ToggleGroupItem>
            </Link>
            <Link href="/account/manage/security" legacyBehavior passHref>
              <ToggleGroupItem value="security" aria-label="Toggle bold" className="justify-start">
                <CircleUser className="w-4 h-4 mr-2" />
                セキュリティ
              </ToggleGroupItem>
            </Link>
            <Link href="/account/manage/personal-data" legacyBehavior passHref>
              <ToggleGroupItem value="personal-data" aria-label="Toggle bold" className="justify-start">
                <CircleUser className="w-4 h-4 mr-2" />
                個人情報
              </ToggleGroupItem>
            </Link>
          </ToggleGroup>
          <div className="w-full">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}