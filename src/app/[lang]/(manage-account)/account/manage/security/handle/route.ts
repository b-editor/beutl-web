import { cookies, headers } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest): NextResponse {
  const cookieStore = cookies();
  const authFlow = cookieStore.get("beutl.auth-flow");
  const requestUrl = new URL(headers().get("x-url") as string);
  requestUrl.pathname = "/account/manage/security";

  if (authFlow?.value) {
    const json = JSON.parse(authFlow?.value);
    if (json.type === "adding-account" && json.url) {
      cookieStore.delete("beutl.auth-flow");
    }
  }

  return NextResponse.redirect(requestUrl.toString());
}