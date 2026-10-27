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
it('leaves viewer pages to Next.js and forwards only unlocalized preview endpoints', async () => {
  const base = `https://preview.test/preview/${'a'.repeat(64)}/11111111-1111-4111-8111-111111111111/`;
  const forward = vi.fn(async () => new Response(null, { status: 401 }));
  const id = { toString: () => 'a'.repeat(64) };
  const env = { PUBLIC_ORIGIN: 'https://preview.test', BEUTL_PREVIEW_SESSIONS: {
    idFromName: () => id, idFromString: () => id, get: () => ({ fetch: forward }),
  } };
  expect(await handlePreviewRequest(new Request(base), env)).toBeNull();
  expect(await handlePreviewRequest(new Request(base.slice(0, -1)), env)).toBeNull();
  expect(await handlePreviewRequest(new Request(base.replace('/preview/', '/en/preview/')), env)).toBeNull();
  expect((await handlePreviewRequest(new Request(`${base}viewer.js`), env))?.status).toBe(404);
  expect((await handlePreviewRequest(new Request(`${base}api/session`), env))?.status).toBe(401);
  expect(forward).toHaveBeenCalledOnce();
  expect((await handlePreviewRequest(new Request(`${base}internal/init`), env))?.status).toBe(404);
  expect((await handlePreviewRequest(new Request(`${base}api/session`.replace('preview.test','other.test')), env))?.status).toBe(403);
  expect(forward).toHaveBeenCalledOnce();
});
