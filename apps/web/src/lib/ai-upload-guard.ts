import { type NextRequest, NextResponse } from "next/server";
import { aiScreenUploadLimit } from "@beutl/core";

/**
 * 大きすぎる AI の送信を、本文を組み立てる前に断る。
 *
 * Server Action の本文上限はアプリ全体で 1 つしかなく、パッケージのアップロード
 * に合わせた大きさになっている。AI の画面が受け取れる量はそれよりずっと小さい
 * のに、1 ファイルごとの上限を見るのは Action が動きはじめてから——つまり本文
 * まるごとが File として組み上がったあとで、有効な 1 枚と無関係な詰め物を並べる
 * だけで、断られるより先にその全部を抱えさせられる。
 *
 * ここで見るのは content-length だけ。名乗った長さが画面の上限を超えていれば、
 * 本文を読まずに断る——名乗らない送信は素通しになるが、そちらは本文の上限が
 * 受け止める。
 */
export function refuseOversizedAiUpload(
  request: NextRequest,
): NextResponse | null {
  if (request.method !== "POST") return null;

  const limit = aiScreenUploadLimit(request.nextUrl.pathname);
  if (limit === null) return null;

  const header = request.headers.get("content-length");
  if (!header) return null;

  const length = Number(header);
  if (!Number.isFinite(length) || length <= limit) return null;

  return new NextResponse(null, { status: 413 });
}
