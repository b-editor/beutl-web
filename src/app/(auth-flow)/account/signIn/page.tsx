// デスクトップアプリからのログインページ
// 互換用に残しているが、今後は使わない

import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default function Page({ searchParams: { returnUrl } }: { searchParams: { returnUrl: string } }) {
  const xurl = headers().get("x-url") as string;
  const origin = new URL(xurl).origin;
  const url = new URL("/account/native-auth/sign-in", origin);
  url.searchParams.set("returnUrl", returnUrl);
  redirect(url.toString());
}
