import { cookies } from "next/headers";
import { type NextRequest, NextResponse } from "next/server";

export function GET(request: NextRequest): NextResponse {
  const cookieStore = cookies();
  const authFlow = cookieStore.get("beutl.auth-flow");
  const searchParams = new URL(request.url).searchParams;

  if (authFlow?.value) {
    const json = JSON.parse(authFlow?.value);
    if (json.type === "adding-account" && json.url) {
      cookieStore.delete("beutl.auth-flow");
      const url = new URL(json.url);
      const error = searchParams.get("error");
      if (error) {
        url.searchParams.set("error", error);
      }
      return NextResponse.redirect(url.toString());
    }
  }

  return NextResponse.redirect("/account/manage/security");
}