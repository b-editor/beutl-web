// vinext より外側の入口。
//
// 名乗った長さが上限を超えていれば、本文には触れずに 413。長さを名乗らないものは
// 数えながら流し、超えたところで切る。どちらも、100MB を 1 リクエストで抱える道を
// 塞ぐためのもの。
//
// Server Action は URL ではなく Next-Action ヘッダーの ID で選ばれるので、AI の
// Action を AI 以外のパスへ送れば、そのパスの上限——全体の上限——で受ける。
// 画面ごとの上限は、その画面へ普通に送られてくるものを縮めるためのもので、
// 境界ではない。
import handler from "vinext/server/fetch-handler";
import { fetchWithBodyLimit } from "./src/lib/worker-body-limit";
import { reconcileWebAiJobs } from "./src/lib/ai-scheduled-reconciliation";

export default {
  async fetch(request, env, ctx) {
    return await fetchWithBodyLimit(request, env, ctx, (bounded, nextEnv, nextCtx) =>
      handler.fetch(bounded, nextEnv, nextCtx),
    );
  },
  async scheduled(controller, env, ctx) {
    // The standalone API Worker is not present in this deployment. Keep paid
    // video jobs moving even when no user has the history page open.
    ctx.waitUntil((async () => {
      const result = await reconcileWebAiJobs(env, new Date(controller.scheduledTime));
      console.log("Scheduled AI reconciliation completed", result);
    })());
  },
};
