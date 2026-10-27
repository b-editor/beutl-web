import { afterEach, expect, it, vi } from 'vitest';
import { createPreviewIceServers } from '../../packages/api/src/preview/turn';

afterEach(() => vi.unstubAllGlobals());

it('issues only expiring TURN credentials, accepting Worker secrets and Secrets Store bindings', async () => {
  const servers = [{ urls: ['turn:turn.example.test:3478'], username: 'temporary-user', credential: 'temporary-secret' }];
  const request = vi.fn(async () => Response.json({ iceServers: servers }));
  vi.stubGlobal('fetch', request);
  for (const key of ['key-id', { get: async () => 'key-id' }])
  for (const secret of ['server-only-token', { get: async () => 'server-only-token' }]) {
    const result = await createPreviewIceServers({ PREVIEW_TURN_KEY_ID: key, PREVIEW_TURN_API_TOKEN: secret });
    expect(result).toEqual(servers);
    expect(JSON.stringify(result)).not.toContain('server-only-token');
  }
  const [url, options] = request.mock.calls[0];
  expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers');
  expect(options.headers.Authorization).toBe('Bearer server-only-token');
  expect(JSON.parse(options.body)).toEqual({ ttl: 14460 });
});

it('reports TURN provisioning failures without exposing permanent credentials', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  await expect(createPreviewIceServers({})).rejects.toThrow('not configured');
  expect(request).not.toHaveBeenCalled();
  const env = { PREVIEW_TURN_KEY_ID: 'key-id', PREVIEW_TURN_API_TOKEN: 'secret' };
  request.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(createPreviewIceServers(env)).rejects.toThrow('could not be created');
  request.mockResolvedValueOnce(Response.json({ iceServers: [{ urls: ['stun:stun.example.test:3478'] }] }));
  await expect(createPreviewIceServers(env)).rejects.toThrow('no relay servers');
});

it('reads both Secrets Store bindings on a new request after rotation', async () => {
  const key = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('rotated');
  const token = vi.fn().mockResolvedValueOnce('token1').mockResolvedValueOnce('token2');
  const request = vi.fn(async () => Response.json({ iceServers: [{ urls: ['turn:example.test'], username: 'short-lived', credential: 'short-lived' }] }));
  vi.stubGlobal('fetch', request);
  const env = { PREVIEW_TURN_KEY_ID: { get: key }, PREVIEW_TURN_API_TOKEN: { get: token } };
  await createPreviewIceServers(env);
  await createPreviewIceServers(env);
  expect(request.mock.calls[1][0]).toContain('/keys/rotated/');
  expect(request.mock.calls[1][1].headers.Authorization).toBe('Bearer token2');
});
