// OpenNext より外側の入口。
//
// 生成されるハンドラは、利用者の middleware を呼ぶより先に本文をまるごと
// `arrayBuffer()` で持つ。だから Next の中では「抱える前に断る」ことができない
// ——断れるのはここだけ。
//
// 名乗った長さが上限を超えていれば、本文には触れずに 413。長さを名乗らないものは
// 数えながら流し、超えたところで切る。どちらも、100MB を 1 リクエストで抱える道を
// 塞ぐためのもの。
//
// Server Action は URL ではなく Next-Action ヘッダーの ID で選ばれるので、AI の
// Action を AI 以外のパスへ送れば、そのパスの上限——全体の上限——で受ける。
// 画面ごとの上限は、その画面へ普通に送られてくるものを縮めるためのもので、
// 境界ではない。
import { boundedBody, requestBodyLimit } from "@beutl/core";
//@ts-expect-error: Will be resolved by wrangler build
import openNext from "./.open-next/worker.js";

//@ts-expect-error: Will be resolved by wrangler build
export { DOQueueHandler } from "./.open-next/worker.js";
//@ts-expect-error: Will be resolved by wrangler build
export { DOShardedTagCache } from "./.open-next/worker.js";
//@ts-expect-error: Will be resolved by wrangler build
export { BucketCachePurge } from "./.open-next/worker.js";

// 下流が本文を持つとみなす条件と、同じにする。OpenNext は GET と HEAD 以外を
// すべて arrayBuffer() で持つので、こちらだけ OPTIONS を本文なしとみなすと、
// 本文の付いた OPTIONS がここを素通りして向こうで抱えられる。
const BODYLESS_METHODS = new Set(["GET", "HEAD"]);

export default {
  async fetch(request, env, ctx) {
    if (BODYLESS_METHODS.has(request.method) || !request.body) {
      return openNext.fetch(request, env, ctx);
    }

    const limit = requestBodyLimit(new URL(request.url).pathname);
    const declared = request.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isFinite(length) || length > limit) {
        return new Response(null, { status: 413 });
      }
      // 名乗った長さは信じきらない。実際に流れるぶんも数える。
    }

    // 作り直すと `cf` は引き継がれない。地域などの手掛かりが要る経路は本文を
    // 持たないので、失われるのは本文のある POST/PUT だけ。
    const bounded = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: boundedBody(request.body, limit),
      signal: request.signal,
      duplex: "half",
    });
    return openNext.fetch(bounded, env, ctx);
  },
};
