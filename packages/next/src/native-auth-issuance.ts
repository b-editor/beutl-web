import "server-only";
import {
  isAllowedNativeAuthContinueUrl,
  nativeAuthCallbackUrl,
  randomString,
} from "@beutl/core";
import {
  findNativeAppAuthById,
  updateNativeAppAuthCode,
} from "@beutl/db";

// 発行済みコードの有効期限。従来の handler ページ・deprecated API と同じ 30 分。
const CODE_TTL_MS = 30 * 60 * 1000;

export type NativeAuthIssueError = "rowNotFound" | "unsafeContinueUrl";

export type NativeAuthIssueResult =
  | { ok: true; callbackUrl: string }
  | { ok: false; reason: NativeAuthIssueError };

/**
 * ネイティブアプリのサインインコードを発行して行に紐づける。
 *
 * 以前の handler ページは GET の描画で直接ここに相当する処理を走らせていたため、
 * 同意なしにサインインユーザーのコードが遷移先 URL に発行されていた
 * (drive-by code issuance)。発行は同意画面の Server Action からのみ呼ぶこと。
 *
 * コードの永続化の前で continue URL を検証し直す。query string 組み立てで
 * 失敗したら書き込まずにエラーを返すため、検証待ちの行にコードが残らない
 * (旧実装は書き込み後に検証しており、拒否されてもコードと userId が残った)。
 */
export async function issueNativeAuthCodeForSession({
  identifier,
  userId,
}: {
  identifier: string;
  userId: string;
}): Promise<NativeAuthIssueResult> {
  const row = await findNativeAppAuthById({ id: identifier });
  if (!row) {
    return { ok: false, reason: "rowNotFound" };
  }

  const code = randomString(32);
  const codeExpires = new Date(Date.now() + CODE_TTL_MS);

  // Revalidate persisted URLs too, including rows created before scheme validation.
  let callbackUrl: string;
  try {
    callbackUrl = nativeAuthCallbackUrl(row.continueUrl, code);
  } catch {
    return { ok: false, reason: "unsafeContinueUrl" };
  }

  try {
    await updateNativeAppAuthCode({
      id: row.id,
      userId,
      codeExpires,
      code,
    });
  } catch {
    // 検証と永続化の間に行が消えた (createNativeAppAuth の行は使い捨てのため
    // 再潜って同じ行に同意できる保証がない)。ダウンタイムの代わりに再試行を促す。
    return { ok: false, reason: "rowNotFound" };
  }

  return { ok: true, callbackUrl };
}

/**
 * 同意画面に表示する宛先ホスト。検証を通らない URL は表示にも出さない
 * (発行側で再度検証するが、画面と発行先が一致していることが同意の条件)。
 */
export function nativeAuthDestinationHost(
  continueUrl: string,
): string | null {
  // isAllowedNativeAuthContinueUrl は scheme・許可リスト・認証情報なしも
  // 検査する (javascript: や user:pass@ の除外は行に保存済みの URL にも必要)。
  let url: URL;
  try {
    url = new URL(continueUrl);
  } catch {
    return null;
  }
  if (!isAllowedNativeAuthContinueUrl(url)) return null;
  return url.host;
}
