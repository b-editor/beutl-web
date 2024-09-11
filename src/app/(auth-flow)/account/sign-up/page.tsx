import { signIn } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KeyRound } from "lucide-react";
import Link from "next/link";
import Image from "next/image";
import { sql } from "@vercel/postgres"
import type {
  AdapterUser,
} from "@auth/core/adapters";
import { redirect } from "next/navigation";

async function signInWithProvider(formData: FormData) {
  "use server";
  const provider = formData.get("provider") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (provider !== "google") {
    return;
  }

  await signIn(provider, { redirectTo: returnUrl || "/" });
}

async function signInWithEmail(formData: FormData) {
  "use server";
  const email = formData.get("email") as string;
  const returnUrl = formData.get("returnUrl") as string | undefined;
  if (!email) {
    return;
  }

  const userResult = await sql<AdapterUser>`
    SELECT * FROM users WHERE email = ${email} LIMIT 1
  `;
  if (userResult.rowCount === 0) {
    // アカウント未作成
    const params = new URLSearchParams();
    params.append("email", email);
    if (returnUrl) {
      params.append("returnUrl", returnUrl);
    }
    redirect(`/account/send-magic-link?${params.toString()}`);
  }

  await signIn("nodemailer", { email, redirectTo: returnUrl || "/" });
}

export default function Page({ searchParams: { returnUrl } }: { searchParams: { returnUrl?: string } }) {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
          <Image width={40} height={40} className="w-10 h-10 align-bottom" src="/img/logo_dark.svg" alt="Logo" />
          <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>サインイン</CardTitle>
            <CardDescription>お使いのアカウントを使用</CardDescription>
          </CardHeader>
          <CardContent>
            <form id="signin-form" action={signInWithEmail}>
              <div className="grid w-full items-center gap-4">
                <div className="flex flex-col space-y-1.5">
                  <Label htmlFor="email">メールアドレス</Label>
                  <Input name="email" id="email" placeholder="me@example.com" />
                </div>
                {/* <div className="flex flex-col space-y-1.5">
                  <div className="flex justify-between items-center">
                    <Label htmlFor="password">パスワード</Label>
                    <Link href="/account/forgot-password" className="text-muted-foreground text-sm font-medium">パスワードを忘れましたか？</Link>
                  </div>
                  <Input name="password" id="password" type="password" placeholder="********" />
                </div> */}
              </div>
              <input type="hidden" name="returnUrl" value={returnUrl} />
            </form>
          </CardContent>
          <CardFooter className="block">
            <Button className="w-full" form="signin-form" type="submit">サインイン</Button>
            <Link href="/account/sign-up" className="text-sm font-medium inline-block mt-6">アカウント作成</Link>
          </CardFooter>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex gap-4">
              <form className="flex-1" action={signInWithProvider}>
                <input type="hidden" name="provider" value="google" />
                <input type="hidden" name="returnUrl" value={returnUrl} />
                <Button variant="outline" className="p-2 w-full" type="submit">
                  <svg className="w-5 h-5" version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">
                    <title>Google</title>
                    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
                    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
                    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
                    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </Button>
              </form>

              <form className="flex-1">
                <input type="hidden" name="returnUrl" value={returnUrl} />
                <Button variant="outline" className="p-2 w-full" type="submit">
                  <svg className="w-5 h-5 invert" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                    <title>GitHub</title>
                    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                  </svg>
                </Button>
              </form>

              <form className="flex-1">
                <input type="hidden" name="returnUrl" value={returnUrl} />
                <Button variant="outline" className="p-2 w-full" type="submit">
                  <KeyRound className="w-5 h-5" />
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>
        <Link className="ml-auto text-sm absolute top-full right-0 translate-y-4" href="docs/privacy">プライバシーポリシー</Link>
      </div>
    </div>
  )
}