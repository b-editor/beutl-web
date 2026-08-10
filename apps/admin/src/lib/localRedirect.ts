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

export async function localRedirect(
  url: string,
  type?: RedirectType,
): Promise<never> {
  const origin = await getRequestOrigin();
  // 検証を通らない入力はサイト内トップへ送る。admin のルートは
  // /{lang}/admin へリダイレクトされるため、安全な既定の遷移先になる。
  const safePath = resolveSafeRedirectPath(url, origin) ?? "/";

  redirect(safePath, type);
}
