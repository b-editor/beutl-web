import { beforeEach, expect, it, vi } from 'vitest';
import preview from '../../packages/api/src/v3/preview';
import { handlePreviewRequest } from '../../packages/api/src/preview/environment';
const auth = vi.hoisted(() => vi.fn());
vi.mock('../../packages/api/src/api/auth', () => ({ getUserId: auth }));
beforeEach(() => auth.mockReset());

it('only creates an account-scoped relay after desktop authentication', async () => {
  const forward = vi.fn(async () => Response.json({ viewerUrl: 'https://preview.test/preview/room/' }));
  const id = { toString: () => 'a'.repeat(64) };
  const namespace = { idFromName: vi.fn(() => id), idFromString: vi.fn(() => id), get: () => ({ fetch: forward }) };
  const env = { BEUTL_PREVIEW_SESSIONS: namespace, PUBLIC_ORIGIN: 'https://preview.test' };
  auth.mockResolvedValue(null);
  expect((await preview.request('https://preview.test/sessions', { method: 'POST' }, env)).status).toBe(401);
  expect(forward).not.toHaveBeenCalled();
  auth.mockResolvedValue('desktop-account');
  expect((await preview.request('https://preview.test/sessions', { method: 'POST' }, env)).status).toBe(200);
  expect(namespace.idFromName).toHaveBeenCalledWith('desktop-account');
  const request = forward.mock.calls[0][0] as Request;
  expect(request.url).toBe('https://preview.internal/init');
  expect(await request.json()).toEqual({ objectId: 'a'.repeat(64), origin: 'https://preview.test' });
  expect((await preview.request('https://preview.test/sessions', { method: 'POST' }, {})).status).toBe(503);
});
it('serves assets without redirecting away from the room, and forwards only preview endpoints', async () => {
  const base = `https://preview.test/preview/${'a'.repeat(64)}/11111111-1111-4111-8111-111111111111/`;
  const assets = vi.fn(async () => new Response('<html>preview</html>', { headers: { 'Content-Type': 'text/html' } }));
  const forward = vi.fn(async () => new Response(null, { status: 401 }));
  const id = { toString: () => 'a'.repeat(64) };
  const env = { PUBLIC_ORIGIN: 'https://preview.test', ASSETS: { fetch: assets }, BEUTL_PREVIEW_SESSIONS: {
    idFromName: () => id, idFromString: () => id, get: () => ({ fetch: forward }),
  } };
  const page = await handlePreviewRequest(new Request(base), env);
  expect(page?.status).toBe(200);
  expect(assets.mock.calls[0][0].url).toBe('https://preview.test/preview-client/');
  expect(page?.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(page?.headers.get('Cache-Control')).toBe('no-store');
  expect((await handlePreviewRequest(new Request(`${base}api/session`), env))?.status).toBe(401);
  expect(forward).toHaveBeenCalledOnce();
  expect((await handlePreviewRequest(new Request(`${base}internal/init`), env))?.status).toBe(404);
  expect((await handlePreviewRequest(new Request(base.replace('preview.test','other.test')), env))?.status).toBe(403);
  expect(forward).toHaveBeenCalledOnce();
});
