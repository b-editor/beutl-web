import { auth } from "@/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { prisma } from "@/prisma";
import { Link2 } from "lucide-react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ChangeUserName } from "./components";

export default async function Page() {
  const session = await auth();
  const url = headers().get("x-url") || "/";
  if (!session?.user) {
    const searchParams = new URLSearchParams();
    searchParams.set("returnUrl", url);
    redirect(`/account/sign-in?${searchParams.toString()}`);
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
          urlTemplate: true,
        }
      }
    }
  });
  const xProfile = socials.find(social => social.provider.name === "x");
  const ghProfile = socials.find(social => social.provider.name === "github");
  const ytProfile = socials.find(social => social.provider.name === "youtube");
  const customProfile = socials.find(social => social.provider.name === "custom");

  return (
    <div>
      <h2 className="font-bold text-2xl">プロフィール</h2>
      <form className="mt-4">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col space-y-1.5 max-w-xs">
            <Label htmlFor="displayName">表示名</Label>
            <Input type="text" id="displayName" name="displayName" defaultValue={profile?.displayName} />
          </div>
          <ChangeUserName profile={profile} />
          <div className="flex flex-col space-y-1.5 max-w-md">
            <Label htmlFor="bio">自己紹介</Label>
            <Textarea id="bio" name="bio" defaultValue={profile?.bio || undefined} />
            <p className="text-sm text-muted-foreground">拡張機能を公開したとき、このプロフィールが表示されます。150文字以下</p>
          </div>

          <h3 className="font-bold text-xl mt-4">ソーシャル</h3>
          <div className="flex gap-4 max-w-xs items-center">
            <svg className="flex-1 max-w-5 invert" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>X</title><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" /></svg>
            <Input className="flex-1" type="text" name="x" defaultValue={xProfile?.value} />
          </div>
          <div className="flex gap-4 max-w-xs items-center">
            <svg className="flex-1 max-w-5 invert" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>GitHub</title><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" /></svg>
            <Input className="flex-1" type="text" name="github" defaultValue={ghProfile?.value} />
          </div>
          <div className="flex gap-4 max-w-xs items-center">
            <svg className="flex-1 max-w-5 invert" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>YouTube</title><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" /></svg>
            <Input className="flex-1" type="text" name="youtube" defaultValue={ytProfile?.value} />
          </div>
          <div className="flex gap-4 max-w-xs items-center">
            <Link2 className="flex-1 max-w-5" />
            <Input className="flex-1" type="text" name="youtube" defaultValue={ytProfile?.value} />
          </div>

          <div className="flex gap-4 my-6">
            <Button type="submit">保存</Button>
            <Button variant="outline" type="reset">変更を破棄</Button>
          </div>
        </div>
      </form>
    </div>
  )
}