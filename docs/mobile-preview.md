# Mobile preview

Phones open the room URL in their browser, enter Beutl's six-digit code and tap
**Enable audio**. The clean preview excludes editing handles and uses the scene's
mixed audio, not microphone or system capture. Sharing stops when the editor tab
changes or closes. Local sharing requires the same network; Internet sharing uses
the existing Beutl Web Worker for pairing and WebRTC signaling.

## Media and HDR

The desktop's Pion WebRTC worker sends encrypted audio/video directly to each
viewer, or through Cloudflare Realtime TURN when a direct connection is unavailable.
Pion is MIT licensed. SIPSorcery is not used. FFmpeg encoding stays in Beutl's existing
separate FFmpeg worker. The installed FFmpeg must include `libvpx`, `libvpx-vp9` (with
10-bit support for HDR) and `libopus`.

- Video: up to 15 fps, 1280 px on the longest edge. SDR uses VP8 at a target 2 Mbit/s
  and the editor's tone mapping. HDR uses VP9 Profile 2, 10-bit BT.2020/PQ at a target
  4 Mbit/s. These are preview targets, not archival/export quality or bitrate limits.
- HDR starts from the floating-point clean frame, before SDR tone mapping. PQ's
  reference white is 203 nit. RTP's negotiated color-space extension carries BT.2020,
  PQ and limited-range metadata so the browser can display the decoded frame correctly.
- The browser selects HDR only when its display advertises high video dynamic range,
  it supports VP9 Profile 2, and it offers the color-space extension. Otherwise it uses
  SDR. If HDR negotiation/encoding fails, it retries in SDR. Browser/OS support varies;
  an HDR label is not a measurement of the physical display.
- Audio: Opus, stereo 48 kHz, target 96 kbit/s, 20 ms packets. The desktop samples the
  currently playing portion of the existing audio buffers, advances RTP time by 960
  samples per packet, and stops sending on pause. Audio and video share a clock and
  WebRTC stream. The phone's audio button satisfies browser autoplay requirements.

The Durable Object carries JSON signaling only (offer, answer, ICE candidates,
playback state and session controls). It rejects binary media. No video or audio is
recorded or stored by the Worker. TURN forwards encrypted WebRTC media.

## Deployment and TURN configuration

The Web deployment includes `BEUTL_PREVIEW_SESSIONS`, the `mobile-preview-v1` SQLite
Durable Object migration and the assets in `apps/web/public/preview-client/`. No SQL
application database migration is needed. Use [deployment.md](deployment.md) for the
normal deployment and existing Secrets Store conventions; preserve unrelated secrets.
`PUBLIC_ORIGIN` must be the canonical HTTPS origin.

Before deploying Internet sharing:

1. Create a Cloudflare Realtime TURN key in the account used for Beutl Web. Retain
   its key ID and the API token authorized to generate credentials for that key.
2. Bind `PREVIEW_TURN_KEY_ID` and `PREVIEW_TURN_API_TOKEN` to the `beutl-web` Worker.
   The ID can be a Worker variable or secret. The token must be a Worker secret or
   Secrets Store binding. For local workerd, place them in `.dev.vars`; never commit
   them or put them in a `NEXT_PUBLIC_` variable. Example for Worker secrets, from
   `apps/web/` (each command prompts for the value):

   ```sh
   vp exec wrangler secret put PREVIEW_TURN_KEY_ID
   vp exec wrangler secret put PREVIEW_TURN_API_TOKEN
   ```

3. Deploy Web, then use the matching desktop build. Creating a room returns 503 when
   TURN is unconfigured/unavailable, before ending any existing room. The Worker calls
   Cloudflare's `generate-ice-servers` endpoint and passes only short-lived credentials
   to paired viewers and the desktop. They expire after the four-hour room plus one
   minute; the long-lived token never leaves the Worker.
4. Verify with a phone on mobile data: wrong-code rejection, video, enable/mute audio,
   seek, pause, loop, reconnect and end sharing. Confirm that a restrictive network can
   use a relay ICE candidate. Check HDR on a compatible phone, plus SDR fallback on an
   SDR display. Local browser tests cannot verify a phone's physical HDR presentation
   or the deployed TURN configuration.

[Cloudflare TURN documentation](https://developers.cloudflare.com/realtime/turn/)
describes key provisioning and the credential API. Configure and review the service's
usage before enabling public Internet sharing.

## Lifetime and limits

- One active room per signed-in account, up to four paired phones. A new room
  invalidates the previous URL and cookies.
- New connections require a code that expires after ten minutes; the desktop can
  renew it. Ten pairing attempts per minute per room; ten room creations per minute
  per account, including rooms already stopped. TURN credential issuance shares that
  creation limit.
- The publisher connection owns the room. Closing/switching editor tabs or losing
  the publisher connection ends sharing. A room also ends after four hours.
  Viewer-only interruptions can reconnect with their cookie.
- Pairing and expiring ICE credentials persist in the Durable Object across hibernation.
  SDP/candidates are routed to the authenticated viewer identity; a viewer cannot
  impersonate another viewer or publish media to the desktop.
- Each profile shares one encoder across viewers. Only the latest source frame is
  retained. RTP packetization, NACK recovery and encryption are handled by the WebRTC
  transport rather than the Worker. This version uses fixed encoding bitrate targets.

Publisher authentication uses a room-scoped secret header, separate from the desktop
API token. Viewer cookies are HttpOnly, SameSite=Strict, Secure on HTTPS and scoped to
the random room path. Same-origin checks and CSP prevent cross-origin pairing or
embedding. The preview has no editing-command or project-file API.

## Client source and verification

The canonical client is `apps/web/public/preview-client/`. Its theme comes from
`packages/ui/src/styles/theme.css`, also imported by the Web application, and its logo
is the existing `logo_dark.svg`. The Web build refreshes those assets. After a client
change, synchronize the desktop's embedded local client:

```sh
vp exec node scripts/sync-preview-client.mjs /path/to/beutl
vp exec vitest run tests/integration/mobile-preview.test.ts tests/contract/mobile-preview-api.test.ts tests/contract/preview-connection.test.ts tests/contract/preview-turn.test.ts tests/contract/web-api-entrypoint.test.ts
vp exec tsc --noEmit -p packages/api/tsconfig.json
```

The integration suite uses real workerd Durable Objects and TCP WebSockets. Test-only
session creation in `tests/fixtures/preview/worker.ts` is never used by the production
Worker. Desktop tests cover clean-frame conversion and playback lifetime; FFmpeg worker
tests decode the encoded VP8/10-bit VP9 frames and exercise immediate Opus output.
Pion tests check negotiated profiles and HDR color metadata. Browser validation should
launch Playwright with `headless: true` and save screenshots without opening a window.
