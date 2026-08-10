import "server-only";
import { headers } from "next/headers";
import { redirect, type RedirectType } from "next/navigation";
import { resolveSafeRedirectPath } from "@beutl/core";

// x-url は middleware が付与するが、開発環境では x-forwarded-proto/host が
// 欠けて "null://..." のような解析不能な値になりうる。その場合は origin を
// 使わず、相対パスのみを許可するモードにフォールバックする。
async function getRequestOrigin(): Promise<string | undefined> {
  const xurl = (await headers()).get("x-url");
  if (!xurl) return undefined;

  try {
    const { origin, protocol } = new URL(xurl);
    if (protocol !== "http:" && protocol !== "https:") return undefined;
    return origin;
  } catch {
    return undefined;
  }
}

// 外部入力の returnUrl を同一オリジンのパスへ正規化する。フォームの hidden
// input や searchParams はクライアントが自由に変えられるため、リダイレクト先や
// callbackURL に渡す前にサーバー側で必ず通すこと。
export async function resolveSafeReturnUrl(
  url: string | null | undefined,
): Promise<string | undefined> {
  return resolveSafeRedirectPath(url, await getRequestOrigin()) ?? undefined;
}

export async function localRedirect(
  url: string,
  type?: RedirectType,
): Promise<never> {
  // 検証を通らない入力はサイト内トップへ送る。両アプリともルートは
  // /{lang}/... へリダイレクトされるため、安全な既定の遷移先になる。
  redirect((await resolveSafeReturnUrl(url)) ?? "/", type);
}
