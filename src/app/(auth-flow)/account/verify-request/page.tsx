import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { auth } from "@/auth";

export default async function Page() {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
          <Image width={40} height={40} className="w-10 h-10 align-bottom" src="/img/logo_dark.svg" alt="Logo" />
          <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>メールを確認してください</CardTitle>
          </CardHeader>
          <CardContent>
            <p>サインイン用のリンクをあなたのメールアドレスに送りました</p>
          </CardContent>
        </Card>
        <Link className="ml-auto text-sm absolute top-full right-0 translate-y-4" href="docs/privacy">プライバシーポリシー</Link>
      </div>
    </div>
  )
}