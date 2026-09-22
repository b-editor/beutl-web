import { type NextRequest, NextResponse } from "next/server";
import { aiScreenUploadLimit } from "@beutl/core";

/**
 * 宣言された長さが AI 画面の上限を超えている場合の早期チェック。
 *
 * セキュリティ境界は OpenNext の外側の worker-body-limit.ts が担う。
 * 実際のストリームを同じ画面別上限で制限し、信用できない Content-Length は
 * 削除してから middleware に渡すため、ここではヘッダーの欠如を拒否しない。
 * Next.js 単体ではアプリ全体の Server Action 上限と Action 内の検証も働く。
 * Action は URL でなく ID で選ばれるので、この画面別チェックだけでは境界に
 * ならない。
 */
export function refuseOversizedAiUpload(
  request: NextRequest,
): NextResponse | null {
  if (request.method !== "POST") return null;

  const limit = aiScreenUploadLimit(request.nextUrl.pathname);
  if (limit === null) return null;

  const header = request.headers.get("content-length");
  if (header === null) return null;

  const length = Number(header);
  if (Number.isFinite(length) && length <= limit) return null;

  return new NextResponse(null, { status: 413 });
}
