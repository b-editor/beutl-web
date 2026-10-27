export type PreviewIceServer = { urls: string[]; username?: string; credential?: string };
export interface PreviewTurnEnvironment {
  PREVIEW_TURN_KEY_ID?: string;
  PREVIEW_TURN_API_TOKEN?: string | { get(): Promise<string> };
}

export async function createPreviewIceServers(env: PreviewTurnEnvironment): Promise<PreviewIceServer[]> {
  const secret = env.PREVIEW_TURN_API_TOKEN;
  const token = typeof secret === 'string' ? secret : await secret?.get();
  if (!env.PREVIEW_TURN_KEY_ID || !token) throw new Error('Preview TURN service is not configured');
  const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.PREVIEW_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 4 * 60 * 60 + 60 }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Preview TURN credentials could not be created');
  const { iceServers } = await response.json() as { iceServers: PreviewIceServer[] };
  if (!Array.isArray(iceServers) || !iceServers.some(server => server.urls.some(url => /^turns?:/u.test(url))))
    throw new Error('Preview TURN service returned no relay servers');
  return iceServers;
}
