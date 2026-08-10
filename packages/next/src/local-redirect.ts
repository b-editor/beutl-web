import "server-only";
import { headers } from "next/headers";
import { redirect, type RedirectType } from "next/navigation";
import {
  resolveNativeAuthContinueTarget,
  resolveSafeRedirectPath,
} from "@beutl/core";

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
  url: string | string[] | null | undefined,
): Promise<string | undefined> {
  return resolveSafeRedirectPath(url, await getRequestOrigin()) ?? undefined;
}

// native-auth の同意画面専用。デスクトップアプリのコールバックは別オリジンに
// なりうるため、同一オリジンに加えてホスト許可リストも受け入れる。
export async function resolveNativeAuthReturnUrl(
  url: string | string[] | null | undefined,
): Promise<string | undefined> {
  return (
    resolveNativeAuthContinueTarget(url, await getRequestOrigin()) ?? undefined
  );
}

export async function localRedirect(
  url: string,
  type?: RedirectType,
): Promise<never> {
  const safePath = await resolveSafeReturnUrl(url);
  // 検証を通らない入力はサイト内トップへ送る。両アプリともルートは
  // /{lang}/... へリダイレクトされるため、安全な既定の遷移先になる。
  // ただし黙って倒すと呼び出し側の不具合がユーザー操作ミスに見えるため記録する。
  if (!safePath) {
    console.error("localRedirect: rejected unsafe redirect target", url);
  }

  redirect(safePath ?? "/", type);
}
