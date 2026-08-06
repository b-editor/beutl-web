// Next.js の instrumentation hook。サーバー起動時に必ずロードされるため、
// @beutl/db の Prisma プロバイダ登録 (./prisma) をここで行う。
// これがないと getDb() が "Db provider is not set" で失敗する。
//
// 注意: instrumentation は Node.js と Edge の両ランタイムでロードされる。
// ./prisma は Node.js 専用 (pg / PrismaClient / Hyperdrive) のため、
// Edge ランタイムでは import をスキップする。スキップしないと crypto 等の
// Node 組み込みモジュールが Edge で評価されエラーになる。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    await import("./prisma");
  }
}
