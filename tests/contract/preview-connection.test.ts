import { expect, it, vi } from 'vitest';
import { PreviewConnection, selectVideoCodec } from '../../apps/web/src/features/preview/connection';

it('uses HDR only with a 10-bit VP9 receiver and HDR display, retaining normal SDR playback', () => {
  const vp8 = { mimeType: 'video/VP8', clockRate: 90000 }, vp9 = { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=0' };
  const hdr = { mimeType: 'video/VP9', clockRate: 90000, sdpFmtpLine: 'profile-id=2' };
  expect(selectVideoCodec([vp8, vp9, hdr], true)).toEqual({ codec: hdr, hdr: true });
  expect(selectVideoCodec([vp8, vp9, hdr], false)).toEqual({ codec: vp8, hdr: false });
  expect(selectVideoCodec([vp8, vp9], true)).toEqual({ codec: vp8, hdr: false });
});
it('waits for the matching control acknowledgement and releases pending controls on disconnect or timeout', async () => {
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn();
    close = vi.fn();
  }
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('location', { href: 'https://preview.test/en/preview/room/session/', protocol: 'https:' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const state = vi.fn(), connection = new PreviewConnection({ srcObject: null } as HTMLVideoElement, '/preview/room/session/', state);
  try {
    await expect(connection.control('play')).resolves.toBe(false);
    await connection.connect();
    expect(fetch).toHaveBeenCalledWith('/preview/room/session/api/session', expect.any(Object));
    connection.peer = { connectionState: 'connected', close: vi.fn() };
    const socket = connection.socket;
    const seek = connection.control('seek', 2.5), completed = vi.fn();
    seek.then(completed);
    const request = JSON.parse(socket.send.mock.calls[0][0]);
    expect(request).toMatchObject({ type: 'control', action: 'seek', position: 2.5 });
    await expect(connection.control('next')).resolves.toBe(false);
    for (const requestId of [undefined, request.requestId + 1]) {
      socket.onmessage({ data: JSON.stringify({ type: 'control-result', requestId, ok: true }) });
      await vi.advanceTimersByTimeAsync(1);
      expect(completed).not.toHaveBeenCalled();
    }
    const playback = { type: 'playback', playing: false, position: 2.5, minimum: 0, duration: 10, frameRate: 30, enabled: true };
    socket.onmessage({ data: JSON.stringify(playback) });
    socket.onmessage({ data: JSON.stringify({ type: 'control-result', requestId: request.requestId, ok: true }) });
    await expect(seek).resolves.toBe(true);
    expect(state).toHaveBeenCalledWith(playback);

    const timedOut = connection.control('play');
    await vi.advanceTimersByTimeAsync(10000);
    await expect(timedOut).resolves.toBe(false);
    const stopped = connection.control('pause');
    connection.close();
    await expect(stopped).resolves.toBe(false);
    await expect(connection.control('next')).resolves.toBe(false);
    expect(state).toHaveBeenLastCalledWith({ type: 'disconnected' });

    await connection.connect();
    connection.peer = { connectionState: 'connected', close: vi.fn() };
    const resumed = connection.control('play'), resumedCallback = vi.fn();
    resumed.then(resumedCallback);
    const resumedRequest = JSON.parse(connection.socket.send.mock.calls[0][0]);
    state.mockClear();
    // Delayed messages from the previous socket must not update a reconnected viewer.
    socket.onmessage({ data: JSON.stringify(playback) });
    socket.onmessage({ data: JSON.stringify({ type: 'control-result', requestId: resumedRequest.requestId, ok: true }) });
    await vi.advanceTimersByTimeAsync(1);
    expect(state).not.toHaveBeenCalled();
    expect(resumedCallback).not.toHaveBeenCalled();
    connection.socket.onmessage({ data: JSON.stringify({ type: 'control-result', requestId: resumedRequest.requestId, ok: true }) });
    await expect(resumed).resolves.toBe(true);
  } finally { connection.close(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it('tries LAN, STUN, then TURN; ignores old answers and stops fallback after connection', async () => {
  vi.useFakeTimers();
  const peers: Peer[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send = vi.fn(); close = vi.fn();
  }
  class Peer {
    connectionState = 'new'; remoteDescription = null;
    close = vi.fn(); addIceCandidate = vi.fn();
    setRemoteDescription = vi.fn(async value => { this.remoteDescription = value; });
    addTransceiver = vi.fn(() => ({ setCodecPreferences: vi.fn() }));
    createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }));
    setLocalDescription = vi.fn(async () => {});
    onconnectionstatechange?: () => void;
    constructor(readonly config: RTCConfiguration) { peers.push(this); }
  }
  vi.stubGlobal('WebSocket', Socket); vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('RTCRtpReceiver', { getCapabilities: () => ({ codecs: [{ mimeType: 'video/VP8', clockRate: 90000 }] }) });
  vi.stubGlobal('MediaStream', class { addTrack = vi.fn(); });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('location', { href: 'https://preview.test/', protocol: 'https:' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  const state = vi.fn(), connection = new PreviewConnection({ srcObject: null } as HTMLVideoElement, '/preview/a/b/', state);
  try {
    await connection.connect();
    const socket = connection.socket;
    socket.onopen();
    const sent = () => socket.send.mock.calls.map(([message]) => JSON.parse(message));
    const configurations = () => sent().filter(s => s.type === 'configure');
    const configure = async (phase: string, iceServers: RTCIceServer[]) => {
      const request = configurations().at(-1);
      expect(request.phase).toBe(phase);
      socket.onmessage({ data: JSON.stringify({ ...request, type: 'config', iceServers }) });
      await vi.advanceTimersByTimeAsync(1);
      return request.connectionId;
    };
    const lan = await configure('lan', []);
    expect(peers[0].config).toEqual({ iceServers: [], iceTransportPolicy: 'all' });
    await vi.advanceTimersByTimeAsync(3000);
    const stunServers = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
    await configure('stun', stunServers);
    expect(peers[0].close).toHaveBeenCalled();
    expect(peers[1].config).toEqual({ iceServers: stunServers, iceTransportPolicy: 'all' });
    socket.onmessage({ data: JSON.stringify({ type: 'answer', connectionId: lan, sdp: 'old answer' }) });
    await vi.advanceTimersByTimeAsync(1);
    expect(peers[1].setRemoteDescription).not.toHaveBeenCalled();
    peers[1].connectionState = 'failed'; peers[1].onconnectionstatechange();
    const turnServers = [{ urls: ['turn:example.test'], username: 'u', credential: 'p' }];
    await configure('turn', turnServers);
    expect(peers[2].config).toEqual({ iceServers: turnServers, iceTransportPolicy: 'relay' });
    peers[2].connectionState = 'connected'; peers[2].onconnectionstatechange();
    await vi.advanceTimersByTimeAsync(20000);
    expect(configurations().map(c => c.phase)).toEqual(['lan', 'stun', 'turn']);
    expect(state).toHaveBeenLastCalledWith({ type: 'connected' });
    expect(new Set(configurations().map(c => c.connectionId)).size).toBe(3);
  } finally { connection.close(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
