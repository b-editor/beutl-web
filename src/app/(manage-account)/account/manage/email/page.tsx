import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { prisma } from "@/prisma";
import { Link2 } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page() {
  const session = await auth();
  const url = headers().get("x-url") || "/";
  if (!session?.user) {
    const searchParams = new URLSearchParams();
    searchParams.set("returnUrl", url);
    redirect(`/account/sign-in?${searchParams.toString()}`);
  }

  // 一応dbから取得
  const user = await prisma.user.findFirst({
    where: {
      id: session.user.id,
    },
  });
  if (!user) {
    throw new Error("ユーザーが見つかりませんでした");
  }

  return (
    <div>
      <h2 className="font-bold text-2xl">メールアドレス</h2>
      <form className="mt-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col space-y-1.5 max-w-xs">
            <Label htmlFor="currentEmail">現在のメールアドレス</Label>
            <Input type="email" id="currentEmail" defaultValue={user?.email} disabled />
          </div>
          <div className="flex flex-col space-y-1.5 max-w-xs">
            <Label htmlFor="newEmail">新しいメールアドレス</Label>
            <Input type="email" id="newEmail" name="newEmail" />
          </div>

          <Button className="my-6 self-start" type="submit">変更</Button>
        </div>
      </form>
    </div>
  )
}