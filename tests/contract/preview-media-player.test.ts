import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreviewMediaPlayer } from '../../apps/web/public/preview-client/media-player.js';

class AudioContext {
  state = 'running'; currentTime = 10;
  sources: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }[] = [];
  async resume() {}
  createBuffer(channels: number, count: number, rate: number) {
    return { duration: count / rate, getChannelData: () => new Float32Array(count) };
  }
  createBufferSource() {
    const source = { start: vi.fn(), stop: vi.fn(), connect: vi.fn() };
    this.sources.push(source); return source;
  }
}
function audio(id: number, time: number) {
  const buffer = new ArrayBuffer(24 + 8000 * 4), view = new DataView(buffer);
  view.setUint8(0, 2); view.setUint16(2, 2, true); view.setUint32(4, 8000, true);
  view.setFloat64(8, time, true); view.setFloat64(16, id, true);
  return buffer;
}
beforeEach(() => vi.stubGlobal('window', { AudioContext }));
afterEach(() => vi.unstubAllGlobals());

it('waits for video before scheduling audio received ahead, including joining mid-buffer', async () => {
  const player = new PreviewMediaPlayer();
  await player.enable();
  player.receiveAudio(audio(1, 2)); player.receiveAudio(audio(1, 3));
  expect(player.context.sources).toHaveLength(0);
  expect(player.video(2.5, 1, true)).toBeCloseTo(120);
  expect(player.context.sources).toHaveLength(2);
  expect(player.context.sources[0].start.mock.calls[0]).toEqual([10.12, .5]);
  expect(player.context.sources[1].start.mock.calls[0]).toEqual([10.62, 0]);
  player.receiveAudio(audio(1, 3));
  expect(player.context.sources).toHaveLength(2);
});
it('stops immediately, rejects packets from the stopped run, and accepts a loop at the same time', async () => {
  const player = new PreviewMediaPlayer(); await player.enable();
  player.receiveAudio(audio(1, 0)); player.video(0, 1, true);
  const source = player.context.sources[0];
  player.stop(1);
  expect(source.stop).toHaveBeenCalledOnce();
  player.receiveAudio(audio(1, 1)); player.video(.5, 1, true);
  expect(player.anchor).toBeNull();
  player.receiveAudio(audio(2, 0)); player.video(0, 2, true);
  expect(player.context.sources).toHaveLength(2);
  player.mute();
  expect(player.context.sources[1].stop).toHaveBeenCalledOnce();
  player.receiveAudio(audio(2, 1)); expect(player.context.sources).toHaveLength(2);
});
it('keeps the next run audio when an old paused image arrives and resets after network stalls', async () => {
  const player = new PreviewMediaPlayer(); await player.enable();
  player.receiveAudio(audio(2, 4)); player.video(0, 0, false);
  expect(player.audio).toHaveLength(1);
  player.video(4, 2, true);
  player.context.currentTime = 12;
  expect(player.video(4.5, 2, true)).toBeCloseTo(120);
  expect(player.context.sources[0].stop).toHaveBeenCalledOnce();
  player.disconnect();
  expect(player.sources.size).toBe(0); expect(player.audio).toHaveLength(0);
  player.receiveAudio(audio(1, 0)); player.video(0, 1, true);
  expect(player.id).toBe(1);
});
it('stops scheduled audio on browser interruption and resumes on the next tap without growing the queue', async () => {
  const changed = vi.fn(), player = new PreviewMediaPlayer(changed);
  await player.enable(); player.receiveAudio(audio(1, 0)); player.video(0, 1, true);
  player.context.state = 'suspended'; player.context.onstatechange();
  expect(player.context.sources[0].stop).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  for (let i = 1; i <= 10; i++) player.receiveAudio(audio(1, i));
  expect(player.sources.size).toBe(0); expect(player.audio.length).toBeLessThanOrEqual(4);
  player.context.state = 'running'; await player.enable(); player.video(10, 1, true);
  expect(player.context.sources).toHaveLength(2);
});
