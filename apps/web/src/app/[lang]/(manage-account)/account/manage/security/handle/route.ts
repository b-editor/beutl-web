import { getLanguage } from "@/lib/lang-utils";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";

export async function GET(): Promise<NextResponse> {
  const cookieStore = await cookies();
  const authFlow = cookieStore.get("beutl.auth-flow");
  const requestUrl = new URL((await headers()).get("x-url") as string);
  requestUrl.pathname = `/${await getLanguage()}/account/manage/security`;

  if (authFlow?.value) {
    const json = JSON.parse(authFlow?.value);
    if (json.type === "adding-account" && json.url) {
      cookieStore.delete("beutl.auth-flow");
    }
  }

  return NextResponse.redirect(requestUrl.toString());
}
