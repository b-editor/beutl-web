"use server";

import { getAuthoritativeSession } from "@/lib/auth-guard";
import { issueNativeAuthCodeForSession } from "@beutl/next/native-auth-issuance";

// 同意ボタン (Server Action) の結果。発行に成功したらデスクトップアプリの
// コールバック URL を返し、クライアント側で location.href する
// (旧 ClientRedirect が担っていた遷移先の検証は発行モジュール側で行う)。
export type NativeAuthIssueState =
  | { status: "idle" }
  | { status: "ok"; callbackUrl: string }
  | { status: "failed" };

export async function issueNativeAuthCodeAction(
  _state: NativeAuthIssueState,
  formData: FormData,
): Promise<NativeAuthIssueState> {
  const identifier = formData.get("identifier");
  if (typeof identifier !== "string" || identifier === "") {
    return { status: "failed" };
  }

  // Sensitive operations must consult the session store even with a valid
  // cache cookie. コード発行は回収可能な(itemView 可能な)トークンを生む
  // 機微操作のため、失効済みセッションでは cookie cache でも発行しない。
  const session = await getAuthoritativeSession();
  if (!session?.user?.id) {
    return { status: "failed" };
  }

  const result = await issueNativeAuthCodeForSession({
    identifier,
    userId: session.user.id,
  });

  if (!result.ok) {
    // 行が無い / 遷移先が検証を通らない。詳細は出さず再試行を促す。
    return { status: "failed" };
  }

  return { status: "ok", callbackUrl: result.callbackUrl };
}
