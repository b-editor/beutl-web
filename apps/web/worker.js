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
import { fetchWithBodyLimit } from "./src/lib/worker-body-limit";
//@ts-expect-error: Will be resolved by wrangler build
import openNext from "./.open-next/worker.js";

//@ts-expect-error: Will be resolved by wrangler build
export { DOQueueHandler } from "./.open-next/worker.js";
//@ts-expect-error: Will be resolved by wrangler build
export { DOShardedTagCache } from "./.open-next/worker.js";
//@ts-expect-error: Will be resolved by wrangler build
export { BucketCachePurge } from "./.open-next/worker.js";

export default {
  async fetch(request, env, ctx) {
    return await fetchWithBodyLimit(request, env, ctx, (bounded, nextEnv, nextCtx) =>
      openNext.fetch(bounded, nextEnv, nextCtx),
    );
  },
};
