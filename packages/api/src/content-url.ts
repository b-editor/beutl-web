// Worker 版コンテンツ URL 生成。
// Web (Next.js) は middleware が注入する x-url ヘッダから origin を導出するが、
// 独立 Worker には middleware が無いため PUBLIC_ORIGIN env を最優先で使う。
export function getContentUrl(
  id: string | null | undefined,
  request?: Request,
): Promise<string | null> {
  const origin = resolveOrigin(request);
  if (!id) return Promise.resolve(null);
  return Promise.resolve(`${origin}/api/contents/${id}`);
}

export function contentPath(id: string): string {
  return `/api/contents/${id}`;
}

function resolveOrigin(request?: Request): string {
  const fromEnv = process.env.PUBLIC_ORIGIN;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (request) return new URL(request.url).origin;
  return "";
}
