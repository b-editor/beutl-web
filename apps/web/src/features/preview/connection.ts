export type PlaybackState = {
  playing: boolean; position: number; minimum: number; duration: number; frameRate: number; enabled: boolean;
};
export type ConnectionStatus = 'pair' | 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'ended' | 'error' | 'unsupported';
export type PreviewUpdate = { type: ConnectionStatus | 'audioFailed' }
  | ({ type: 'playback' } & Partial<PlaybackState>) | { type: 'range'; range: 'HDR' | 'SDR' };
export type PreviewAction = 'play' | 'pause' | 'previous' | 'next' | 'seek';
type Signal = { ended: true } | { type: 'config'; iceServers: RTCIceServer[] }
  | { type: 'answer'; sdp: string; hdr: boolean } | { type: 'candidate'; candidate: RTCIceCandidateInit }
  | ({ type: 'playback' } & Partial<PlaybackState>) | { type: 'control-result'; requestId: number; ok: boolean }
  | { type: 'error'; fatal?: boolean } | { type: 'state'; state: string };

const colorSpaceURI = 'http://www.webrtc.org/experiments/rtp-hdrext/color-space';

export function selectVideoCodec(codecs: RTCRtpCodec[], hdrDisplay: boolean) {
  const hdr = hdrDisplay && codecs.find(codec => codec.mimeType.toLowerCase() === 'video/vp9' &&
    /(?:^|;)\s*profile-id=2(?:;|$)/u.test(codec.sdpFmtpLine || ''));
  return { hdr: !!hdr, codec: hdr || codecs.find(codec => codec.mimeType.toLowerCase() === 'video/vp8') };
}

// Connection/reconnect/negotiation only. The viewer owns DOM, localization, audio gestures and full screen.
export class PreviewConnection {
  private generation = 0;
  private retry = 1000;
  private allowHdr = true;
  private hdr = false;
  private timer?: ReturnType<typeof setTimeout>;
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private controlSequence = 0;
  private pendingControl?: { id: number; timer: ReturnType<typeof setTimeout>; resolve: (ok: boolean) => void };
  ended = false;
  socket: WebSocket | null = null;
  peer: RTCPeerConnection | null = null;

  constructor(private readonly video: HTMLVideoElement, private readonly basePath: string,
    private readonly state: (update: PreviewUpdate) => void) { }

  close() {
    ++this.generation;
    clearTimeout(this.timer);
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
    if (this.peer) { this.peer.close(); this.peer = null; }
    this.video.srcObject = null;
    this.finishControl(false, this.pendingControl?.id);
    this.state({ type: 'disconnected' });
  }

  async connect() {
    this.close();
    if (document.hidden || this.ended) return;
    const generation = this.generation;
    try {
      const response = await fetch(this.basePath + 'api/session', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (generation !== this.generation) return;
      if (response.status === 401) { this.state({ type: 'pair' }); return; }
      if (response.status === 404 || response.status === 410) { this.end(); return; }
      if (!response.ok) throw new Error('Session unavailable');
      this.state({ type: 'connecting' });
      const url = new URL(this.basePath + 'stream', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = this.socket = new WebSocket(url);
      let messages = Promise.resolve();
      socket.onmessage = event => {
        messages = messages.then(async () => {
          if (generation !== this.generation) return;
          await this.handleSignal(JSON.parse(event.data) as Signal, socket, generation);
        }).catch(() => {
          // A broken signaling exchange is retried with a fresh peer connection.
          if (generation === this.generation) this.reconnect();
        });
      };
      socket.onclose = () => { if (generation === this.generation) this.reconnect(); };
    } catch {
      // A temporary network failure does not invalidate the paired device.
      if (generation === this.generation) this.reconnect();
    }
  }

  async handleSignal(signal: Signal, socket: WebSocket, generation: number) {
    if ('ended' in signal) { this.end(); return; }
    switch (signal.type) {
      case 'config':
        await this.negotiate(signal.iceServers, socket, generation);
        break;
      case 'answer': {
        const peer = this.peer!;
        await peer.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
        if (generation !== this.generation) return;
        for (const candidate of this.remoteCandidates) await peer.addIceCandidate(candidate);
        if (generation !== this.generation) return;
        this.remoteCandidates = [];
        this.state({ type: 'range', range: signal.hdr ? 'HDR' : 'SDR' });
        break;
      }
      case 'candidate':
        if (this.peer?.remoteDescription) await this.peer.addIceCandidate(signal.candidate);
        else this.remoteCandidates.push(signal.candidate);
        break;
      case 'playback': this.state(signal); break;
      case 'control-result': this.finishControl(signal.ok === true, signal.requestId); break;
      case 'error':
        if (this.hdr && !signal.fatal) { this.allowHdr = false; this.reconnect(); }
        else { this.close(); this.state({ type: 'error' }); }
        break;
    }
  }

  async negotiate(iceServers: RTCIceServer[], socket: WebSocket, generation: number) {
    if (!globalThis.RTCPeerConnection || !globalThis.RTCRtpReceiver) { this.close(); this.state({ type: 'unsupported' }); return; }
    const peer = this.peer = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'all' });
    this.remoteCandidates = [];
    const stream = new MediaStream();
    this.video.srcObject = stream;
    peer.ontrack = ({ track }) => {
      if (generation !== this.generation) return;
      stream.addTrack(track);
      track.onunmute = () => {
        if (generation === this.generation) this.video.play().catch(() => {
          // Autoplay may require a user gesture even after a track arrives.
          if (generation === this.generation) this.state({ type: 'audioFailed' });
        });
      };
    };
    peer.onconnectionstatechange = () => {
      if (generation !== this.generation) return;
      if (peer.connectionState === 'connected') { this.retry = 1000; this.state({ type: 'connected' }); }
      if (peer.connectionState === 'failed') this.reconnect();
      if (peer.connectionState === 'disconnected') {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => { if (peer.connectionState === 'disconnected') this.reconnect(); }, 3000);
      }
    };
    let offered = false;
    const candidates: { type: string; candidate: RTCIceCandidateInit }[] = [];
    peer.onicecandidate = ({ candidate }) => {
      if (!candidate || generation !== this.generation) return;
      const signal = { type: 'candidate', candidate: candidate.toJSON() };
      if (offered) socket.send(JSON.stringify(signal)); else candidates.push(signal);
    };
    const video = peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });
    const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
    const selected = selectVideoCodec(codecs, this.allowHdr && matchMedia('(video-dynamic-range: high)').matches);
    if (!selected.codec) { this.close(); this.state({ type: 'unsupported' }); return; }
    this.hdr = selected.hdr;
    video.setCodecPreferences([selected.codec]);
    let offer = await peer.createOffer();
    // Color metadata is needed even when a browser can decode 10-bit VP9. Never label it HDR without it.
    if (this.hdr && !offer.sdp?.includes(colorSpaceURI)) {
      this.hdr = false;
      const sdr = selectVideoCodec(codecs, false).codec;
      if (!sdr) { this.close(); this.state({ type: 'unsupported' }); return; }
      video.setCodecPreferences([sdr]);
      offer = await peer.createOffer();
    }
    await peer.setLocalDescription(offer);
    if (generation !== this.generation) return;
    socket.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, hdr: this.hdr }));
    offered = true;
    for (const candidate of candidates) socket.send(JSON.stringify(candidate));
  }

  control(action: PreviewAction, position?: number) {
    if (this.pendingControl || this.socket?.readyState !== WebSocket.OPEN || this.peer?.connectionState !== 'connected')
      return Promise.resolve(false);
    return new Promise<boolean>(resolve => {
      const id = ++this.controlSequence;
      const timer = setTimeout(() => this.finishControl(false, id), 10000);
      this.pendingControl = { id, timer, resolve };
      try { this.socket!.send(JSON.stringify({ type: 'control', requestId: id, action, position })); }
      catch {
        // A socket can close between the ready-state check and the send.
        this.finishControl(false, id);
      }
    });
  }

  finishControl(ok: boolean, id?: number) {
    const pending = this.pendingControl;
    if (!pending || pending.id !== id) return;
    this.pendingControl = undefined;
    clearTimeout(pending.timer);
    pending.resolve(ok);
  }

  reconnect() {
    this.close();
    if (document.hidden || this.ended) return;
    this.state({ type: 'reconnecting' });
    this.timer = setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(this.retry * 2, 10000);
  }

  end() { this.ended = true; this.close(); this.state({ type: 'ended' }); }
}
