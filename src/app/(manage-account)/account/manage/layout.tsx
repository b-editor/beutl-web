import { Navigation } from "./components";
import { auth } from "@/auth";
import NavBar from "@/components/nav-bar";
import { Button } from "@/components/ui/button";
import { UserCircle } from "lucide-react";
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
        <div className="flex flex-col md:grid md:grid-cols-[max-content,1fr] gap-6 items-start">
          <Navigation />
          <div className="w-full">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}