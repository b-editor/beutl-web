import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import WebSocket from 'ws';
import { once } from 'node:events';

let origin: string;
let mf: Miniflare;
const sockets = new Set<WebSocket>();
const script = buildSync({
  entryPoints: ['tests/fixtures/preview/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral',
}).outputFiles[0].text;
beforeEach(async () => { mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script, compatibilityDate: '2025-04-04',
  durableObjects: { BEUTL_PREVIEW_SESSIONS: { className: 'PreviewSessionDurableObject', useSQLite: true } },
})); origin = (await mf.ready).origin; });
afterEach(async () => { for (const socket of sockets) socket.terminate(); sockets.clear(); await mf.dispose(); });
async function create() {
  return await (await mf.dispatchFetch(`${origin}/create`)).json() as {
    viewerUrl: string; publisherUrl: string; publisherToken: string; pairingCode: string;
  };
}
function messages(socket: WebSocket) {
  sockets.add(socket);
  const received: (string | ArrayBuffer)[] = [];
  socket.on('message', (data, isBinary) => {
    const buffer = Buffer.from(data as Buffer);
    received.push(isBinary ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) : buffer.toString());
    if (!isBinary && buffer.toString() === '{"ended":true}') socket.close();
  });
  return received;
}
async function publisher(session: Awaited<ReturnType<typeof create>>) {
  const socket = new WebSocket(session.publisherUrl, { headers: { Authorization: `Bearer ${session.publisherToken}` } });
  const received = messages(socket);
  await once(socket, 'open');
  return { socket, received };
}
async function pair(session: Awaited<ReturnType<typeof create>>) {
  const response = await mf.dispatchFetch(`${session.viewerUrl}api/pair`, {
    method: 'POST', headers: { Origin: origin }, body: session.pairingCode,
  });
  expect(response.status).toBe(204);
  const cookie = response.headers.get('set-cookie')!;
  expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
  expect(cookie).toContain(`Path=${new URL(session.viewerUrl).pathname}`);
  return cookie.split(';')[0];
}
async function viewer(session: Awaited<ReturnType<typeof create>>, cookie: string) {
  const socket = new WebSocket(`${session.viewerUrl.replace(/^http/u, 'ws')}stream`, { headers: {
    Origin: origin, Cookie: cookie,
  } });
  const received = messages(socket); await once(socket, 'open');
  return { socket, received };
}
describe('mobile preview on workerd', () => {
  it('requires credentials, code and same origin; revokes devices and expires when the host closes', async () => {
    const session = await create();
    expect((await mf.dispatchFetch(session.publisherUrl.replace(/^ws/u, 'http'), { headers: { Upgrade: 'websocket' } })).status).toBe(401);
    const host = await publisher(session);
    expect((await mf.dispatchFetch(`${session.viewerUrl}api/session`)).status).toBe(401);
    expect((await mf.dispatchFetch(`${session.viewerUrl}api/pair`, { method: 'POST', headers: { Origin: 'https://other.test' }, body: session.pairingCode })).status).toBe(403);
    expect((await mf.dispatchFetch(`${session.viewerUrl}api/pair`, { method: 'POST', headers: { Origin: origin }, body: 'invalid' })).status).toBe(401);
    const cookie = await pair(session), phone = await viewer(session, cookie);
    await expect.poll(() => host.received.some(x => typeof x === 'string' && x.startsWith('{') && JSON.parse(x).clients?.length === 1)).toBe(true);
    expect((await mf.dispatchFetch(`${session.viewerUrl}stream`, { headers: { Upgrade: 'websocket', Origin: 'https://other.test', Cookie: cookie } })).status).toBe(403);
    host.socket.send(JSON.stringify({ type: 'disconnectAll' }));
    await expect.poll(async () => (await mf.dispatchFetch(`${session.viewerUrl}api/session`, { headers: { Cookie: cookie } })).status).toBe(401);
    await expect.poll(() => phone.received.includes('{"ended":true}')).toBe(true);
    expect(phone.socket.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    host.socket.close();
    await expect.poll(async () => (await mf.dispatchFetch(`${session.viewerUrl}api/session`)).status).toBe(410);
  });
  it('routes offers and ICE by paired socket identity and rejects media relay', async () => {
    const session = await create(), host = await publisher(session);
    const first = await viewer(session, await pair(session)), second = await viewer(session, await pair(session));
    first.socket.send(JSON.stringify({ type: 'offer', id: 'forged', sdp: 'first-offer', hdr: true }));
    second.socket.send(JSON.stringify({ type: 'offer', sdp: 'second-offer', hdr: false }));
    const signals = () => host.received.filter((x): x is string => typeof x === 'string').map(x => JSON.parse(x)).filter(x => x.type === 'signal');
    await expect.poll(() => signals().length).toBe(2);
    const one = signals().find(s => s.signal.sdp === 'first-offer');
    const two = signals().find(s => s.signal.sdp === 'second-offer');
    expect(one.id).not.toBe('forged'); expect(one.id).not.toBe(two.id);
    host.socket.send(JSON.stringify({ type: 'signal', id: one.id, signal: { type: 'answer', sdp: 'only-first' } }));
    await expect.poll(() => first.received.some(x => typeof x === 'string' && JSON.parse(x).sdp === 'only-first')).toBe(true);
    expect(second.received.some(x => typeof x === 'string' && JSON.parse(x).sdp === 'only-first')).toBe(false);
    first.socket.send(JSON.stringify({ type: 'candidate', candidate: { candidate: 'ice' } }));
    await expect.poll(() => signals().length).toBe(3);
    expect(signals()[2].id).toBe(one.id);
    host.socket.send(new Uint8Array([1, 2, 3]));
    await expect.poll(() => host.socket.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
  });
  it('restarts immediately without an old socket close deleting the new session', async () => {
    const first = await create(), oldHost = await publisher(first), second = await create();
    expect(second.viewerUrl).not.toBe(first.viewerUrl);
    await expect.poll(() => oldHost.received.includes('{"ended":true}')).toBe(true);
    expect(oldHost.socket.readyState).toBeGreaterThanOrEqual(WebSocket.CLOSING);
    const host = await publisher(second);
    await pair(second);
    expect((await mf.dispatchFetch(`${first.viewerUrl}api/session`)).status).toBe(410);
    host.socket.close();
  });
  it('limits devices and attempts while allowing renewed codes', async () => {
    const session = await create(), host = await publisher(session);
    for (let i = 0; i < 4; i++) await pair(session);
    const attempt = (body: string) => mf.dispatchFetch(`${session.viewerUrl}api/pair`, { method: 'POST', headers: { Origin: origin }, body });
    expect((await attempt(session.pairingCode)).status).toBe(409);
    for (let i = 0; i < 5; i++) expect((await attempt('wrong')).status).toBe(401);
    expect((await attempt(session.pairingCode)).status).toBe(429);
    host.socket.send(JSON.stringify({ type: 'pairing', code: '123456', expires: Date.now() + 60_000 }));
    host.socket.send(JSON.stringify({ type: 'disconnectAll' }));
    await expect.poll(async () => (await attempt('123456')).status).toBe(204);
    host.socket.close();
  });
  it('keeps the per-account creation limit after stopping a session', async () => {
    for (let i = 0; i < 10; i++) {
      const host = await publisher(await create());
      host.socket.close();
      await expect.poll(() => host.socket.readyState).toBe(3);
    }
    expect((await mf.dispatchFetch(`${origin}/create`)).status).toBe(429);
  });
});
