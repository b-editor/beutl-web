import { type NextRequest, NextResponse } from "next/server";
import { getLanguage } from "@beutl/next/language";

// デスクトップ (api/v2/identity/signInWith シム) 用の譲渡ルート。
//
// 以前はここでサーバー側 auth.api.signInSocial を呼び、OAuth の authorize
// URL へ飛ばしていた。その構造では state cookie が「サイトからプロバイダ
// へのリダイレクト応答」で配られるため、ブラウザ環境によって callback 時の
// state 検証が失敗し、better-auth が既定の "/" (= ランディングページ) に
// 落ちる事象がデスクトップから報告された。
//
// そこで OAuth state の発行をサインインページの same-origin POST
// (authClient) に譲る。ここでは provider と返り先をサインインページへ接続
// するだけでよい。provider が指定された場合、サインインページが自動で
// ソーシャルサインインを開始する。サインイン済みの場合も同ページの
// session 分岐が返り先へ直行する。
export async function GET(request: NextRequest) {
  const lang = await getLanguage();
  const url = new URL(request.url);
  const signInUrl = new URL(`/${lang}/account/sign-in`, url.origin);
  signInUrl.searchParams.set(
    "returnUrl",
    url.searchParams.get("returnUrl") || "",
  );

  // デスクトップは PascalCase ("Google"/"GitHub") で渡す。provider が
  // 未知の値なら自動開始させず通常のフォームを出す。
  const provider = url.searchParams.get("provider")?.toLowerCase() ?? "";
  if (provider === "google" || provider === "github") {
    signInUrl.searchParams.set("provider", provider);
  }

  return NextResponse.redirect(signInUrl.toString());
}
