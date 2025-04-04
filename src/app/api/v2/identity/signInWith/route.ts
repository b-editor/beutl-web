import { getLanguage } from "@/lib/lang-utils";
import { type NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider") as string;
  const returnUrl = req.nextUrl.searchParams.get("returnUrl") as string;
  const lang = await getLanguage();
  const url = new URL(`/${lang}/account/native-auth/sign-in-with`, req.nextUrl.origin);
  url.searchParams.set("provider", provider);
  url.searchParams.set("returnUrl", returnUrl);
  return NextResponse.redirect(url);
}
