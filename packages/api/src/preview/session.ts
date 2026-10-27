import { PREVIEW_PATH, previewHeaders } from './environment';
import { createPreviewIceServers, type PreviewIceServer, type PreviewTurnEnvironment, STUN_SERVERS, type PreviewPhase } from './turn';

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
  role: 'viewer'; session: string; id: string; address: string;
  negotiation?: { connectionId: string; phase: PreviewPhase };
};
type Session = {
  id: string; origin: string; path: string; publisherToken: string; code: string; codeExpires: number;
  expires: number; attemptWindow: number; attempts: number;
  paired: { token: string; id: string; address: string }[]; turnServers?: PreviewIceServer[];
};
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
const code = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, '0');
const json = (value: unknown) => JSON.stringify(value);
const cookieName = 'beutl-preview';

// Pairing and short-lived ICE credentials survive hibernation. This object only relays signaling;
// audio/video travel over WebRTC (directly or through TURN), never through the Worker.
export class PreviewSessionDurableObject {
  private session?: Session;
  private turnRequest?: Promise<PreviewIceServer[]>;
  private creationLimit = { window: 0, count: 0 };
  constructor(private readonly state: State, private readonly env: PreviewTurnEnvironment) {
    state.blockConcurrencyWhile(async () => {
      this.session = await state.storage.get<Session>('session');
      this.creationLimit = await state.storage.get<typeof this.creationLimit>('creationLimit') || { window: 0, count: 0 };
    });
  }
  private publisher() { return this.state.getWebSockets('publisher').find(s => s.readyState === 1 && s.deserializeAttachment().session === this.session?.id); }
  private viewers() { return this.state.getWebSockets('viewer').filter(s => s.readyState === 1 && s.deserializeAttachment().session === this.session?.id); }
  private save() { return this.state.storage.put('session', this.session!); }
  private send(socket: Socket, message: string | ArrayBuffer) {
    try { socket.send(message); }
    catch {
      // The peer can close between the ready-state check and send; close only that connection.
      socket.close(1011, 'Connection lost');
    }
  }
  private end(socket: Socket, reason: string) {
    this.send(socket, '{"ended":true}');
    socket.close(1000, reason);
  }
  private roster() {
    const host = this.publisher();
    if (!host) return;
    const viewers = this.viewers().map(s => s.deserializeAttachment()).filter((a): a is Extract<Attachment, { role: 'viewer' }> => a.role === 'viewer');
    this.send(host, json({
      clients: viewers.map(v => ({ id: v.id, address: v.address })),
      paired: this.session!.paired.map(p => ({ id: p.id, address: p.address })),
    }));
  }
  private closeViewers(id?: string) {
    for (const socket of this.viewers()) {
      const a = socket.deserializeAttachment();
      if (a.role === 'viewer' && (!id || a.id === id)) this.end(socket, 'Sharing ended');
    }
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
        this.turnRequest = undefined;
        for (const socket of this.state.getWebSockets()) this.end(socket, 'New sharing session');
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
        this.roster();
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
      pair[1].serializeAttachment({ role: 'viewer', session: s.id, id: paired.id, address: paired.address });
      this.state.acceptWebSocket(pair[1], ['viewer']);
      this.roster();
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    });
  }
  async webSocketMessage(socket: Socket, message: string | ArrayBuffer): Promise<void> {
    const a = socket.deserializeAttachment();
    if (a.session !== this.session?.id) return;
    if (!this.session || Date.now() >= this.session.expires) { await this.alarm(); return; }
    if (typeof message !== 'string' || message.length > 64 * 1024) {
      socket.close(1009, 'Signaling message required'); return;
    }
    let control: { type?: string; id?: string; code?: string; expires?: number; signal?: { type?: string; connectionId?: string }; connectionId?: string; phase?: PreviewPhase };
    try { control = JSON.parse(message); }
    catch {
      // Invalid client input ends this socket, without failing the shared session.
      socket.close(1003, 'Invalid signaling'); return;
    }
    if (a.role === 'publisher') {
      if (socket !== this.publisher()) return;
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
      } else if (control.type === 'signal' && control.signal && typeof control.id === 'string') {
        const target = this.viewers().find(s => {
          const viewer = s.deserializeAttachment();
          return viewer.role === 'viewer' && viewer.id === control.id;
        });
        if (target) {
          const viewer = target.deserializeAttachment();
          if (viewer.role === 'viewer' && (!control.signal.connectionId || control.signal.connectionId === viewer.negotiation?.connectionId))
            this.send(target, json(control.signal));
        }
      }
      return;
    }
    // Identity and ICE configuration come from the paired socket and server, never the offer.
    if (!this.session.paired.some(p => p.id === a.id) || !this.viewers().includes(socket)) return;
    if (control.type === 'configure') {
      if (typeof control.connectionId !== 'string' || !/^[a-f0-9-]{36}$/u.test(control.connectionId) ||
          !['lan', 'stun', 'turn'].includes(control.phase || '')) return;
      a.negotiation = { connectionId: control.connectionId, phase: control.phase! };
      socket.serializeAttachment(a);
      try {
        const iceServers = await this.iceServers(a.negotiation.phase);
        if (this.current(socket, a.session, control.connectionId))
          this.send(socket, json({ type: 'config', ...a.negotiation, iceServers }));
      } catch {
        // Never leak provider errors or Secrets Store values to clients/logs.
        if (this.current(socket, a.session, control.connectionId))
          this.send(socket, json({ type: 'error', connectionId: control.connectionId, message: 'relay-unavailable' }));
      }
      return;
    }
    if (control.type !== 'offer' && control.type !== 'candidate' && control.type !== 'control') {
      socket.close(1003, 'Unsupported preview message'); return;
    }
    if (control.type !== 'control' && (!a.negotiation || control.connectionId !== a.negotiation.connectionId)) return;
    const host = this.publisher();
    if (host) {
      const signal = control.type === 'offer'
        ? { ...control, iceServers: await this.iceServers(a.negotiation!.phase), relayOnly: a.negotiation!.phase === 'turn' }
        : control;
      if (control.type === 'control' || this.current(socket, a.session, control.connectionId!))
        this.send(host, json({ type: 'signal', id: a.id, signal }));
    }
  }
  private current(socket: Socket, session: string, connectionId: string) {
    const a = socket.deserializeAttachment();
    return this.session?.id === session && a.role === 'viewer' &&
      a.negotiation?.connectionId === connectionId && this.viewers().includes(socket) &&
      this.session.paired.some(p => p.id === a.id);
  }
  private async iceServers(phase: PreviewPhase): Promise<PreviewIceServer[]> {
    if (phase === 'lan') return [];
    if (phase === 'stun') return STUN_SERVERS;
    const session = this.session!;
    if (session.turnServers) return session.turnServers;
    this.turnRequest ??= createPreviewIceServers(this.env);
    const request = this.turnRequest;
    try {
      const servers = await request;
      if (this.session === session) {
        session.turnServers = servers;
        await this.save();
      }
      return servers;
    } finally { if (this.turnRequest === request) this.turnRequest = undefined; }
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
      await this.state.storage.delete('session');
    } else {
      this.roster();
    }
  }
  async webSocketError(socket: Socket): Promise<void> { socket.close(1011, 'Connection lost'); await this.webSocketClose(socket); }
  async alarm(): Promise<void> {
    for (const socket of this.state.getWebSockets()) this.end(socket, 'Sharing expired');
    this.session = undefined;
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
