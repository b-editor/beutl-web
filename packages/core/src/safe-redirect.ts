// サインイン後の returnUrl など、外部入力に由来するリダイレクト先を検証する。
// url.startsWith("/") だけでは "//evil.com" や "/\evil.com" が通過し、
// ブラウザからは外部オリジンとして解決されるため、必ず URL として解決して
// オリジンを比較する。
//
// 戻り値は同一オリジンのパス (path + search + hash) に正規化したもの。
// 安全でない入力に対しては null を返す。

// origin が判別できない場合に、相対パスだけを受理するための基準オリジン。
// この値自体へリダイレクトすることはない (常にパスへ正規化して返すため)。
const RELATIVE_ONLY_BASE = "http://localhost";

export function resolveSafeRedirectPath(
  url: string | null | undefined,
  origin?: string,
): string | null {
  if (!url) return null;

  const base = origin ?? RELATIVE_ONLY_BASE;

  let resolved: URL;
  try {
    resolved = new URL(url, base);
  } catch {
    return null;
  }

  // javascript: や data: などのスキームを除外する。
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    return null;
  }

  // 解決後のオリジンが基準と異なるものはすべて外部遷移とみなす。
  if (resolved.origin !== base) {
    return null;
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
