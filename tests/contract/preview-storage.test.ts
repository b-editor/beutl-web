import { afterEach, expect, it, vi } from 'vitest';
import { PreviewSessionDurableObject } from '../../packages/api/src/preview/session';

afterEach(() => vi.useRealTimers());

async function room() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T00:00:00Z'));
  const data = new Map<string, any>();
  let alarm: number | undefined;
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    deleteAll: vi.fn(async () => { data.clear(); }),
    setAlarm: vi.fn(async (value: number) => { alarm = value; }),
    deleteAlarm: vi.fn(async () => { alarm = undefined; }),
  };
  const initialization: Promise<unknown>[] = [];
  let host: any;
  const state = { storage, acceptWebSocket: vi.fn(), getWebSockets: (tag?: string) => tag !== 'viewer' && host ? [host] : [],
    blockConcurrencyWhile: <T>(task: () => Promise<T>) => { const result = task(); initialization.push(result); return result; },
  };
  const object = new PreviewSessionDurableObject(state, {});
  await Promise.all(initialization);
  expect(storage.get.mock.calls).toEqual([['session']]); // No rate-limit read on every hibernation wake.
  const response = await object.fetch(new Request('https://preview.internal/init', { method: 'POST',
    body: JSON.stringify({ objectId: 'a'.repeat(64), origin: 'https://preview.test' }),
  }));
  const session = await response.json() as { viewerUrl: string; pairingCode: string };
  host = { readyState: 1, send: vi.fn(), close: vi.fn(), deserializeAttachment: () => ({ role: 'publisher', session: data.get('session')?.id }) };
  return { object, storage, data, host, session, alarm: () => alarm };
}

it('writes once per pairing attempt and never writes again for attempts already over the limit', async () => {
  const { object, storage, session } = await room();
  const pair = (code: string) => object.fetch(new Request(session.viewerUrl + 'api/pair', {
    method: 'POST', headers: { Origin: 'https://preview.test' }, body: code,
  }));
  storage.put.mockClear();
  expect((await pair(session.pairingCode)).status).toBe(204);
  expect(storage.put).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 9; i++) expect((await pair('wrong')).status).toBe(401);
  expect(storage.put).toHaveBeenCalledTimes(10);
  for (let i = 0; i < 20; i++) expect((await pair(session.pairingCode)).status).toBe(429);
  expect(storage.put).toHaveBeenCalledTimes(10);
  vi.advanceTimersByTime(60_000);
  expect((await pair(session.pairingCode)).status).toBe(204);
  expect(storage.put).toHaveBeenCalledTimes(11);
});

it('retains a live creation limit after a quick stop, then deletes all storage and the alarm', async () => {
  const { object, storage, data, host, alarm } = await room();
  await object.webSocketClose(host);
  expect(data.has('session')).toBe(false);
  expect(data.get('creationLimit').count).toBe(1);
  expect(alarm()).toBe(Date.now() + 60_000);
  vi.advanceTimersByTime(60_000);
  await object.alarm();
  expect(storage.deleteAll).toHaveBeenCalledOnce();
  expect(data.size).toBe(0);
  expect(alarm()).toBeUndefined();
});

it('removes the expiry alarm immediately after a normal stop, without leaving stored rate-limit rows', async () => {
  const { object, data, host, alarm } = await room();
  vi.advanceTimersByTime(60_000);
  await object.webSocketClose(host);
  expect(data.size).toBe(0);
  expect(alarm()).toBeUndefined();
});
