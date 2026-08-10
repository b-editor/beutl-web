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
  url: string | string[] | null | undefined,
  origin?: string,
): string | null {
  // Next.js は同じクエリキーが繰り返されると配列を渡す。そのまま URL へ渡すと
  // "/a,/b" という同一オリジンの文字列として通ってしまうため、先頭だけを採る。
  const value = Array.isArray(url) ? url[0] : url;
  if (!value) return null;

  const base = origin ?? RELATIVE_ONLY_BASE;

  let resolved: URL;
  try {
    resolved = new URL(value, base);
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

  // "/..//evil.com" は URL 解決で "//evil.com" というパスへ正規化される。
  // オリジンは基準と一致するのでここまで通るが、返した文字列をそのまま
  // redirect() や router.push() へ渡すとブラウザはプロトコル相対 URL と解釈し、
  // https://evil.com へ遷移してしまう。先頭が "//" のパスは拒否する。
  if (resolved.pathname.startsWith("//")) {
    return null;
  }

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
