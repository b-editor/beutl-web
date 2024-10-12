import { auth } from "@/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

export default async function Page({
  searchParams: { returnUrl }
}: { searchParams: { returnUrl: string } }
) {
  const session = await auth();
  if (!session?.user) {
    redirect(`/account/sign-in?returnUrl=${encodeURIComponent(returnUrl)}`);
  }
  const user = session.user;

  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
          <Image width={40} height={40} className="w-10 h-10 align-bottom" src="/img/logo_dark.svg" alt="Logo" />
          <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>確認</CardTitle>
            <CardDescription>このアカウントで続行しますか</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="w-full flex gap-4">
              <Avatar className="w-12 h-12">
                <AvatarFallback>{user.email?.charAt(0)?.toUpperCase()}</AvatarFallback>
                {user.image && <AvatarImage src={user.image} alt="Profile image" />}
              </Avatar>
              <div className="flex flex-col">
                <p className="font-bold">{user.name}</p>
                <p className="text-muted-foreground">{user.email}</p>
              </div>
            </div>
          </CardContent>
          <CardFooter className="block">
            <Button className="w-full" asChild>
              <Link href={returnUrl}>続行</Link>
            </Button>
            <Link href="/account/sign-up" className="text-sm font-medium inline-block mt-6">他のアカウントを使う</Link>
          </CardFooter>
        </Card>
        <Link className="ml-auto text-sm absolute top-full right-0 translate-y-4" href="/docs/privacy">プライバシーポリシー</Link>
      </div>
    </div>
  )
}