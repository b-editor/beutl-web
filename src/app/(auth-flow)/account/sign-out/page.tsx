import { signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import Image from "next/image";

async function signOutAction(formData: FormData) {
  "use server";
  await signOut({ redirectTo: "/" });
}

export default function Page() {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="w-[350px] flex flex-col gap-4 relative">
        <div className="flex gap-2 absolute bottom-full left-1/2 -translate-x-1/2 -translate-y-4">
          <Image width={40} height={40} className="w-10 h-10 align-bottom" src="/img/logo_dark.svg" alt="Logo" />
          <h1 className="font-semibold text-3xl mt-1">Beutl</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>サインアウト</CardTitle>
          </CardHeader>
          <CardContent>
            <p>サインアウトしますか？</p>
          </CardContent>
          <CardFooter className="block">
            <form id="signin-form" action={signOutAction} className="w-full">
              <Button className="w-full" form="signin-form" type="submit">サインアウト</Button>
            </form>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}