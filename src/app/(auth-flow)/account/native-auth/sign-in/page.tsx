import { auth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function Page({ searchParams: { returnUrl } }: { searchParams: { returnUrl: string } }) {
  const session = await auth();
  const url = headers().get("x-url") as string;
  const origin = new URL(url).origin;
  const continueUrl = new URL("/account/native-auth/continue", origin);
  continueUrl.searchParams.set("returnUrl", returnUrl);
  
  if (!session?.user) {
    const url = new URL("/account/sign-in");
    url.searchParams.set("returnUrl", continueUrl.toString());
    redirect(url.toString());
  }else{
    // アカウントが存在する
    redirect(continueUrl.toString());
  }
}
