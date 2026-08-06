import { Hono } from "hono";
import { getLanguage } from "./lang-utils";

// v2/identity/signInWith は NextResponse.redirect (デフォルト 307) の単一リダイレクトシム。
// Hono 化しても 307 を明示維持する (デスクトップアプリとの契約)。
export const v2 = new Hono().get("/identity/signInWith", async (c) => {
  const provider = c.req.query("provider") ?? "";
  const returnUrl = c.req.query("returnUrl") ?? "";
  const lang = await getLanguage(c.req.raw);
  const url = new URL(`/${lang}/account/native-auth/sign-in-with`, c.req.url);
  url.searchParams.set("provider", provider);
  url.searchParams.set("returnUrl", returnUrl);
  return c.redirect(url, 307);
});
