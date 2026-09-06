import { type NextRequest, NextResponse } from "next/server";
import { aiScreenUploadLimit } from "@beutl/core";

/**
 * 大きすぎる AI の送信を、Action が組み立てる前に断る。
 *
 * Server Action の本文上限はアプリ全体で 1 つしかなく、パッケージの送信に
 * 合わせた大きさになっている。AI の画面が受け取れる量はそれよりずっと小さい
 * のに、1 ファイルごとの上限を見るのは Action が動きはじめてから——つまり
 * FormData が File として組み上がったあとで、有効な 1 枚と無関係な詰め物を
 * 並べるだけで、断られるより先にその全部を抱えさせられる。ここで断てば、
 * 少なくともその組み立ては起きない。
 *
 * **これは境界ではない。** 二つ、素通りする道がある。
 *
 * 1. Server Action は URL ではなく Next-Action ヘッダーの ID で選ばれる。
 *    AI の Action を AI 以外のパスへ POST すれば、この関数は何も言わない。
 * 2. Cloudflare へは OpenNext 経由で出ており、生成されるハンドラは利用者の
 *    middleware を呼ぶ前に `event.arrayBuffer()` で本文をまるごと持つ。
 *    ここで 413 を返しても、その保持はもう済んでいる。
 *
 * どちらも、全体の上限 100MB までを 1 リクエストで抱えられるという話に行き着く
 * ——そしてそれは AI に限らず、パッケージ送信の Action でも同じ。塞ぐには
 * OpenNext より外側の Worker で数えるか、パッケージ送信を Server Action から
 * 外して全体の上限そのものを下げるしかない。ここが受け持つのは、間違って大きな
 * ものを選んだ普通の利用者の分だけ。
 */
export function refuseOversizedAiUpload(
  request: NextRequest,
): NextResponse | null {
  if (request.method !== "POST") return null;

  const limit = aiScreenUploadLimit(request.nextUrl.pathname);
  if (limit === null) return null;

  // 長さを名乗らない送信は断る。この画面へ本文を送るのはブラウザのフォームと
  // Server Action だけで、どちらも長さを付ける——付かないものは、量が分から
  // ないまま通すことになる。
  const header = request.headers.get("content-length");
  if (header === null) return new NextResponse(null, { status: 411 });

  const length = Number(header);
  if (Number.isFinite(length) && length <= limit) return null;

  return new NextResponse(null, { status: 413 });
}
