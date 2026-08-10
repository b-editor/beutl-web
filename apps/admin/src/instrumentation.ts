// Next.js の instrumentation hook。サーバー起動時に必ずロードされるため、
// @beutl/db の Prisma プロバイダ登録 (./prisma) をここで行う。
// Edge ランタイムでは Node.js 専用モジュールを import しない。
export async function register() {
  if (process.env.NEXT_RUNTIME !== "edge") {
    await import("./prisma");
  }
}
