# Mobile preview relay

The desktop sends the clean SDR preview and the scene's mixed audio to an outbound
WebSocket on the existing `beutl-web` Worker. Phones open the HTTPS room URL, enter
the desktop's six-digit connection code, and tap **Enable audio**. No app installation,
VPN, inbound port, or router configuration is required. The relay cannot access
project files or invoke editing commands.

## Deployment

Deploy this change before enabling Internet sharing in the desktop build. The normal
Web deployment includes the `BEUTL_PREVIEW_SESSIONS` binding, the
`mobile-preview-v1` SQLite Durable Object migration and the assets in
`apps/web/public/preview-client/`. No database migration or new secret is required.
Use the existing Web deployment procedure in [deployment.md](deployment.md).
`PUBLIC_ORIGIN` must be the canonical HTTPS origin (currently
`https://beutl.beditor.net`). Do not reset existing Worker variables or secrets.

Check the following after deployment with a signed-in desktop and a phone on mobile
internet: create a room, reject an incorrect code, receive video, enable/mute audio,
seek, pause, loop, close the sharing window, and confirm the phone reports sharing
ended. Check `/api/v3/preview/sessions` still requires desktop authentication.
Local workerd/browser tests do not replace this device/network check.

## Lifetime and limits

- One active room per signed-in account, up to four paired phones. Starting a new
  room invalidates the previous URL and all its cookies.
- New connections require a code that expires after ten minutes; the desktop can
  renew it. Ten pairing attempts per minute per room; ten creations per minute per
  account, including sessions that have already stopped.
- The host connection owns the room. Closing/switching editor tabs or losing the
  host connection ends sharing. Start again for a fresh URL. A room also ends after
  four hours. Viewer-only connection interruptions can reconnect using their cookie.
- Only small authentication/lifetime records persist in the Durable Object. Media
  stays in memory and is neither recorded nor written to object storage.
- Each viewer has independent video/audio acknowledgements. Retain at most one newer
  video frame and two audio blocks for a slow viewer. Pausing and ending sharing
  bypass those acknowledgements.

## Media protocol v1

A binary packet has a 24-byte little-endian header:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | uint8 | 1 = JPEG video; 2 = interleaved PCM16 audio |
| 1 | uint8 | playing (0/1) |
| 2 | uint16 | audio channel count (2), or 0 for video |
| 4 | uint32 | audio sample rate, or 0 for video |
| 8 | float64 | media time in seconds |
| 16 | float64 | integer playback ID; changes on every play/loop |
| 24 | bytes | JPEG or PCM16 payload |

The desktop caps video at 15 fps / 1280 px on the longest edge. Audio is composed
by the existing playback engine and sent ahead; it is **not** a microphone or system
audio capture. The browser uses video timestamps and a 120 ms buffer to schedule
both media on its audio clock, trims audio when joining mid-buffer, and discards
stale playback IDs on pause/seek/loop. The first version uses PCM16, about 192 kB/s
at 48 kHz stereo before transport overhead, plus variable JPEG bandwidth. It does
not provide compressed audio, WebRTC or archival/export quality.

Browser controls are `ready`, `audio-ready`, `audio-on`, `audio-off`. The host may send
`{"playing":false,"playbackId":N}` and the relay sends `{"ended":true}` before closing.
Publisher authentication is a room-scoped secret header, separate from the desktop
API token. Viewer cookies are HttpOnly, SameSite=Strict, Secure on HTTPS and scoped
to the random room path. Same-origin pairing/WebSockets and CSP prevent embedding
or cross-origin access.

## Client source and tests

The canonical client is `src/Beutl/PreviewStreaming/Client/` in the Beutl repository.
Keep all four files byte-identical in `apps/web/public/preview-client/`; the desktop
embeds them for same-network sharing. Do not independently change either copy.

Run `vp exec vitest run tests/integration/mobile-preview.test.ts tests/contract/mobile-preview-api.test.ts tests/contract/preview-media-player.test.ts tests/contract/web-api-entrypoint.test.ts`
and `vp exec tsc --noEmit -p packages/api/tsconfig.json`. The integration suite runs
actual workerd Durable Objects with TCP WebSockets. Test-only session creation in
`tests/fixtures/preview/worker.ts` is never used by the production Worker.
