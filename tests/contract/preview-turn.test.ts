import { afterEach, expect, it, vi } from 'vitest';
import { createPreviewIceServers } from '../../packages/api/src/preview/turn';

afterEach(() => vi.unstubAllGlobals());

it('issues only expiring TURN credentials, accepting Worker secrets and Secrets Store bindings', async () => {
  const servers = [{ urls: ['turn:turn.example.test:3478'], username: 'temporary-user', credential: 'temporary-secret' }];
  const request = vi.fn(async () => Response.json({ iceServers: servers }));
  vi.stubGlobal('fetch', request);
  for (const secret of ['server-only-token', { get: async () => 'server-only-token' }]) {
    const result = await createPreviewIceServers({ PREVIEW_TURN_KEY_ID: 'key-id', PREVIEW_TURN_API_TOKEN: secret });
    expect(result).toEqual(servers);
    expect(JSON.stringify(result)).not.toContain('server-only-token');
  }
  const [url, options] = request.mock.calls[0];
  expect(url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers');
  expect(options.headers.Authorization).toBe('Bearer server-only-token');
  expect(JSON.parse(options.body)).toEqual({ ttl: 14460 });
});

it('does not open an Internet room without a usable relay service', async () => {
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
