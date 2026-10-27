import { PREVIEW_PATH, previewHeaders } from './environment';

interface Socket extends WebSocket {
  serializeAttachment(value: Attachment): void;
  deserializeAttachment(): Attachment;
}
interface State {
  storage: {
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<boolean>;
    setAlarm(time: number): Promise<void>;
  };
  blockConcurrencyWhile<T>(work: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: Socket, tags?: string[]): void;
  getWebSockets(tag?: string): Socket[];
}
declare const WebSocketPair: { new(): { 0: Socket; 1: Socket } };
type Attachment = { role: 'publisher'; session: string } | {
  role: 'viewer'; session: string; id: string; address: string; ready: boolean; audioReady: boolean; audio: boolean;
};
type Session = {
  id: string; origin: string; path: string; publisherToken: string; code: string; codeExpires: number;
  expires: number; attemptWindow: number; attempts: number;
  paired: { token: string; id: string; address: string }[];
};
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const code = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
const json = (value: unknown) => JSON.stringify(value);
const cookieName = 'beutl-preview';

// Only pairing metadata is persisted. Media stays in bounded in-memory queues, never R2 or the database.
export class PreviewSessionDurableObject {
  private session?: Session;
  private creationLimit = { window: 0, count: 0 };
  private pendingVideo = new Map<string, ArrayBuffer>();
  private pendingAudio = new Map<string, ArrayBuffer[]>();
  private recentAudio: ArrayBuffer[] = [];
  private lastVideo?: ArrayBuffer;
  constructor(private readonly state: State) {
    state.blockConcurrencyWhile(async () => {
      this.session = await state.storage.get<Session>('session');
      this.creationLimit = await state.storage.get<typeof this.creationLimit>('creationLimit') || { window: 0, count: 0 };
    });
  }
  private publisher() { return this.state.getWebSockets('publisher').find(s => s.readyState === 1 && s.deserializeAttachment().session === this.session?.id); }
  private viewers() { return this.state.getWebSockets('viewer').filter(s => s.readyState === 1 && s.deserializeAttachment().session === this.session?.id); }
  private save() { return this.state.storage.put('session', this.session!); }
  private send(socket: Socket, message: string | ArrayBuffer) {
    try { socket.send(message); } catch { socket.close(1011, 'Connection lost'); }
  }
  private end(socket: Socket, reason: string) {
    this.send(socket, '{"ended":true}');
    socket.close(1000, reason);
  }
  private roster() {
    const host = this.publisher();
    if (!host) return;
    const viewers = this.viewers().map(s => s.deserializeAttachment()).filter((a): a is Extract<Attachment, { role: 'viewer' }> => a.role === 'viewer');
    this.send(host, json({ clients: viewers.map(v => ({ id: v.id, address: v.address })) }));
    this.send(host, viewers.some(v => v.audio) ? 'audio-on' : 'audio-off');
  }
  private closeViewers(id?: string) {
    for (const socket of this.viewers()) {
      const a = socket.deserializeAttachment();
      if (a.role === 'viewer' && (!id || a.id === id)) this.end(socket, 'Sharing ended');
    }
    if (id) { this.pendingVideo.delete(id); this.pendingAudio.delete(id); }
    else { this.pendingVideo.clear(); this.pendingAudio.clear(); }
  }
  async fetch(request: Request): Promise<Response> {
    const input = request.method === 'POST' && new URL(request.url).pathname.endsWith('/api/pair')
      ? await readCode(request) : null;
    return this.state.blockConcurrencyWhile(async () => {
      const url = new URL(request.url), now = Date.now();
      if (url.origin === 'https://preview.internal' && url.pathname === '/init' && request.method === 'POST') {
        // A burst permits stop/start while a persistent per-account limit bounds creation work.
        // Keep the counter after the host disconnects so repeated stop/start cannot reset it.
        if (now - this.creationLimit.window >= 60_000) this.creationLimit = { window: now, count: 0 };
        if (this.creationLimit.count >= 10) return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
        this.creationLimit.count++;
        await this.state.storage.put('creationLimit', this.creationLimit);
        const { objectId, origin } = await request.json() as { objectId: string; origin: string };
        for (const socket of this.state.getWebSockets()) this.end(socket, 'New sharing session');
        this.pendingAudio.clear(); this.pendingVideo.clear(); this.recentAudio = []; this.lastVideo = undefined;
        const id = crypto.randomUUID();
        this.session = {
          id, origin, path: `/preview/${objectId}/${id}/`, publisherToken: token(), code: code(),
          codeExpires: now + 10 * 60_000, expires: now + 4 * 60 * 60_000,
          attemptWindow: now, attempts: 0, paired: [],
        };
        await this.save();
        // An unclaimed session is removed quickly if the desktop closes during creation.
        await this.state.storage.setAlarm(now + 60_000);
        return Response.json({
          viewerUrl: `${origin}${this.session.path}`,
          publisherUrl: `${origin.replace(/^http/u, 'ws')}${this.session.path}publisher`,
          publisherToken: this.session.publisherToken, pairingCode: this.session.code,
          codeExpires: new Date(this.session.codeExpires).toISOString(),
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
      const s = this.session;
      const match = PREVIEW_PATH.exec(url.pathname);
      if (!s || !match || match[2] !== s.id || now >= s.expires) return new Response(null, { status: 410 });
      const headers = previewHeaders(s.origin);
      const result = (status: number) => new Response(null, { status, headers });
      if (url.origin !== s.origin) return result(403);
      const path = match[3];
      if (path === '/publisher' && request.method === 'GET') {
        if (request.headers.get('Authorization') !== `Bearer ${s.publisherToken}`) return result(401);
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return result(426);
        if (this.publisher()) return result(409);
        const pair = new WebSocketPair();
        pair[1].serializeAttachment({ role: 'publisher', session: s.id });
        this.state.acceptWebSocket(pair[1], ['publisher']);
        await this.state.storage.setAlarm(s.expires);
        this.roster();
        return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
      }
      if (!this.publisher()) return result(410);
      const origin = request.headers.get('Origin');
      if (origin && origin !== s.origin) return result(403);
      const cookie = request.headers.get('Cookie')?.split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      let paired = s.paired.find(p => p.token === cookie);
      if (path === '/api/pair' && request.method === 'POST') {
        if (origin !== s.origin) return result(403);
        if (now - s.attemptWindow >= 60_000) { s.attemptWindow = now; s.attempts = 0; }
        // Count before reading the body; persist across hibernation and concurrent requests.
        if (s.attempts++ >= 10) { await this.save(); return result(429); }
        await this.save();
        if (input !== s.code || now >= s.codeExpires) return result(401);
        if (paired) return result(204);
        if (s.paired.length >= 4) return result(409);
        paired = { token: token(), id: crypto.randomUUID(), address: request.headers.get('CF-Connecting-IP') || 'Browser' };
        s.paired.push(paired);
        await this.save();
        const response = result(204);
        response.headers.set('Set-Cookie', `${cookieName}=${paired.token}; Path=${s.path}; HttpOnly; SameSite=Strict${url.protocol === 'https:' ? '; Secure' : ''}`);
        return response;
      }
      if (path === '/api/session' && request.method === 'GET') return result(paired ? 204 : 401);
      if (path !== '/stream' || request.method !== 'GET') return result(404);
      if (!paired) return result(401);
      if (origin !== s.origin) return result(403);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return result(426);
      this.closeViewers(paired.id);
      const pair = new WebSocketPair();
      pair[1].serializeAttachment({ role: 'viewer', session: s.id, id: paired.id, address: paired.address, ready: true, audioReady: true, audio: false });
      this.state.acceptWebSocket(pair[1], ['viewer']);
      if (this.lastVideo) this.deliver(pair[1], this.lastVideo);
      this.roster();
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    });
  }
  private deliver(socket: Socket, packet: ArrayBuffer) {
    const a = socket.deserializeAttachment();
    if (a.role !== 'viewer') return;
    const audio = new Uint8Array(packet)[0] === 2;
    if (audio && !a.audio) return;
    if (audio ? a.audioReady : a.ready) {
      if (audio) a.audioReady = false; else a.ready = false;
      socket.serializeAttachment(a);
      this.send(socket, packet);
    } else if (audio) {
      this.pendingAudio.set(a.id, [...(this.pendingAudio.get(a.id) || []), packet].slice(-2));
    } else this.pendingVideo.set(a.id, packet);
  }
  async webSocketMessage(socket: Socket, message: string | ArrayBuffer): Promise<void> {
    const a = socket.deserializeAttachment();
    if (a.session !== this.session?.id) return;
    if (!this.session || Date.now() >= this.session.expires) { await this.alarm(); return; }
    if (a.role === 'publisher') {
      if (socket !== this.publisher()) return;
      if (typeof message !== 'string') {
        if (message.byteLength < 24 || message.byteLength > 4 * 1024 * 1024) { socket.close(1009, 'Invalid media packet'); return; }
        const kind = new Uint8Array(message)[0];
        if (kind !== 1 && kind !== 2) { socket.close(1003, 'Invalid media type'); return; }
        if (kind === 1) this.lastVideo = message;
        else {
          const id = new DataView(message).getFloat64(16, true);
          this.recentAudio = this.recentAudio.filter(p => new DataView(p).getFloat64(16, true) === id);
          this.recentAudio.push(message); this.recentAudio = this.recentAudio.slice(-2);
        }
        for (const viewer of this.viewers()) this.deliver(viewer, message);
        this.send(socket, kind === 1 ? 'ready' : 'audio-ready');
        return;
      }
      if (message.length > 4096) { socket.close(1009, 'Invalid control'); return; }
      let control: { type?: string; id?: string; code?: string; expires?: number; playing?: boolean };
      try { control = JSON.parse(message); } catch { socket.close(1003, 'Invalid control'); return; }
      if (control.type === 'pairing' && /^\d{6}$/u.test(control.code || '') && Number.isFinite(control.expires)) {
        this.session.code = control.code!;
        this.session.codeExpires = Math.min(control.expires!, Date.now() + 10 * 60_000);
        this.session.attempts = 0; this.session.attemptWindow = Date.now();
        await this.save();
      } else if (control.type === 'disconnect' || control.type === 'disconnectAll') {
        if (control.type === 'disconnect' && typeof control.id !== 'string') return;
        const id = control.type === 'disconnectAll' ? undefined : control.id;
        this.session.paired = this.session.paired.filter(p => id !== undefined && p.id !== id);
        await this.save(); this.closeViewers(id); this.roster();
      } else if (control.playing === false) {
        this.recentAudio = []; this.pendingAudio.clear(); this.pendingVideo.clear(); this.lastVideo = undefined;
        for (const viewer of this.viewers()) this.send(viewer, message);
      }
      return;
    }
    if (typeof message !== 'string' || !['ready', 'audio-ready', 'audio-on', 'audio-off'].includes(message)) {
      socket.close(1003, 'Read-only preview'); return;
    }
    if (message === 'audio-on' || message === 'audio-off') {
      a.audio = message === 'audio-on';
      this.pendingAudio.delete(a.id);
      socket.serializeAttachment(a);
      if (a.audio) for (const packet of this.recentAudio) this.deliver(socket, packet);
      this.roster();
    } else {
      const audio = message === 'audio-ready';
      if (audio) a.audioReady = true; else a.ready = true;
      socket.serializeAttachment(a);
      const packet = audio ? this.pendingAudio.get(a.id)?.shift() : this.pendingVideo.get(a.id);
      if (!audio) this.pendingVideo.delete(a.id);
      if (packet) this.deliver(socket, packet);
    }
  }
  async webSocketClose(socket: Socket): Promise<void> {
    // The deployed compatibility date predates automatic close replies.
    if (socket.readyState !== 3) socket.close(1000, "Sharing ended");
    const a = socket.deserializeAttachment();
    if (a.session !== this.session?.id) return;
    if (a.role === 'publisher') {
      // The host owns the lifetime. A closed tab or disconnected host ends access immediately.
      this.closeViewers();
      this.session = undefined;
      this.lastVideo = undefined; this.recentAudio = [];
      await this.state.storage.delete('session');
    } else {
      this.pendingVideo.delete(a.id); this.pendingAudio.delete(a.id);
      this.roster();
    }
  }
  async webSocketError(socket: Socket): Promise<void> { socket.close(1011, 'Connection lost'); await this.webSocketClose(socket); }
  async alarm(): Promise<void> {
    for (const socket of this.state.getWebSockets()) this.end(socket, 'Sharing expired');
    this.session = undefined;
    this.pendingVideo.clear(); this.pendingAudio.clear(); this.recentAudio = []; this.lastVideo = undefined;
    await this.state.storage.delete('session');
  }
}

async function readCode(request: Request): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: number[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (chunks.length + value.length > 6) { await reader.cancel(); return null; }
      chunks.push(...value);
    }
    return new TextDecoder().decode(new Uint8Array(chunks));
  } finally { reader.releaseLock(); }
}
