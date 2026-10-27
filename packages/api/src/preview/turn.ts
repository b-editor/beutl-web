import type { SecretsStoreSecret } from '../worker-secrets';

export type PreviewIceServer = { urls: string[]; username?: string; credential?: string };
export type PreviewPhase = 'lan' | 'stun' | 'turn';
export const STUN_SERVERS: PreviewIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478'] }];
export interface PreviewTurnEnvironment {
  PREVIEW_TURN_KEY_ID?: string | SecretsStoreSecret;
  PREVIEW_TURN_API_TOKEN?: string | SecretsStoreSecret;
}

// Deliberately resolved only for the TURN attempt, not by the global Worker secret resolver.
// LAN/STUN and unrelated pages remain usable when the optional relay service is unavailable.
export async function createPreviewIceServers(env: PreviewTurnEnvironment): Promise<PreviewIceServer[]> {
  const read = async (value: string | SecretsStoreSecret | undefined) => typeof value === 'string' ? value : value?.get();
  const [key, token] = await Promise.all([read(env.PREVIEW_TURN_KEY_ID), read(env.PREVIEW_TURN_API_TOKEN)]);
  if (!key || !token) throw new Error('Preview TURN service is not configured');
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key)}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 4 * 60 * 60 + 60 }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('Preview TURN credentials could not be created');
  const { iceServers } = await response.json() as { iceServers: PreviewIceServer[] };
  if (!Array.isArray(iceServers) || !iceServers.some(server => server.urls.some(url => /^turns?:/u.test(url))))
    throw new Error('Preview TURN service returned no relay servers');
  return iceServers;
}
