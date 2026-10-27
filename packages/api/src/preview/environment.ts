import type { PreviewTurnEnvironment } from './turn';

interface PreviewObjectId { toString(): string }
export interface PreviewEnvironment extends PreviewTurnEnvironment {
  PUBLIC_ORIGIN?: string;
  BEUTL_PREVIEW_SESSIONS?: {
    idFromName(name: string): PreviewObjectId;
    idFromString(name: string): PreviewObjectId;
    get(id: PreviewObjectId): { fetch(request: Request): Promise<Response> };
  };
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

// One active session per account. The second, random component changes on every start.
export const PREVIEW_PATH = /^\/preview\/([a-f0-9]{64})\/([a-f0-9-]{36})(\/.*)?$/u;
export const PREVIEW_ASSETS = new Set(['index.html', 'viewer.js', 'viewer.css', 'preview-connection.js', 'theme.css', 'logo.svg']);
export function previewHeaders(origin: string): HeadersInit {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; " +
      `connect-src 'self' ${origin.replace(/^http/u, 'ws')}; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
  };
}

// Before OpenNext: neither locale redirects nor its request-body buffering apply to live media.
export async function handlePreviewRequest(request: Request, env: PreviewEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/preview/')) return null;
  const match = PREVIEW_PATH.exec(url.pathname);
  if (!match || !env.BEUTL_PREVIEW_SESSIONS) return new Response(null, { status: 404 });
  const origin = new URL(env.PUBLIC_ORIGIN || url.origin).origin;
  if (url.origin !== origin) return new Response(null, { status: 403 });
  if (!match[3]) return Response.redirect(`${url.origin}${url.pathname}/`, 308);
  const asset = match[3] === '/' ? 'index.html' : match[3].slice(1);
  if (request.method === 'GET' && PREVIEW_ASSETS.has(asset) && env.ASSETS) {
    const response = await env.ASSETS.fetch(new Request(`${origin}/preview-client/${asset === "index.html" ? "" : asset}`));
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(previewHeaders(origin))) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  }
  // No internal routes or arbitrary URLs can be forwarded by this endpoint.
  if (!['/api/pair', '/api/session', '/stream', '/publisher'].includes(match[3]))
    return new Response(null, { status: 404 });
  const namespace = env.BEUTL_PREVIEW_SESSIONS;
  let id: PreviewObjectId;
  try { id = namespace.idFromString(match[1]); }
  catch {
    // A 64-character hex string can still be invalid for this Durable Object namespace.
    return new Response(null, { status: 404 });
  }
  return namespace.get(id).fetch(request);
}
