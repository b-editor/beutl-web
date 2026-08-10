import { resolveSafeRedirectPath } from "./safe-redirect";

// Hosts allowed as the native-app sign-in continue URL. createAuthUri validates
// the continue_uri against this list when minting a NativeAppAuth, and the
// native-auth handler page re-validates it before redirecting the auth code
// back to the desktop app. Both must agree, so the list lives here.
const ALLOWED_CONTINUE_URL_HOSTS = ["localhost", "beutl.beditor.net"];

export function isAllowedContinueUrlHost(hostname: string): boolean {
  return ALLOWED_CONTINUE_URL_HOSTS.includes(hostname);
}

// native-auth の同意画面の遷移先。通常はサイト内のハンドラーページ (同一オリジン)
// だが、デスクトップアプリはローカルの待ち受け URL を渡すため別オリジンにもなる。
// 同一オリジン判定だけでは後者を弾いてしまうので、弾かれた場合は createAuthUri と
// 同じホスト許可リストで再判定する。許可リスト外は null。
export function resolveNativeAuthContinueTarget(
  url: string | string[] | null | undefined,
  origin?: string,
): string | null {
  const samePath = resolveSafeRedirectPath(url, origin);
  if (samePath) return samePath;

  const value = Array.isArray(url) ? url[0] : url;
  if (!value) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  return isAllowedContinueUrlHost(parsed.hostname) ? parsed.toString() : null;
}
