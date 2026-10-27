import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { selectVideoCodec } from '../../apps/web/public/preview-client/preview-connection.js';

it('uses HDR only with a 10-bit VP9 receiver and HDR display, retaining normal SDR playback', () => {
  const vp8 = { mimeType: 'video/VP8' }, vp9 = { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' };
  const hdr = { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=2' };
  expect(selectVideoCodec([vp8, vp9, hdr], true)).toEqual({ codec: hdr, hdr: true });
  expect(selectVideoCodec([vp8, vp9, hdr], false)).toEqual({ codec: vp8, hdr: false });
  expect(selectVideoCodec([vp8, vp9], true)).toEqual({ codec: vp8, hdr: false });
});
it('uses the same theme and logo as the web application', async () => {
  expect(await readFile('apps/web/public/preview-client/theme.css', 'utf8')).toBe(await readFile('packages/ui/src/styles/theme.css', 'utf8'));
  expect(await readFile('apps/web/public/preview-client/logo.svg', 'utf8')).toBe(await readFile('apps/web/public/img/logo_dark.svg', 'utf8'));
});
