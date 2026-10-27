/**
 * ICE servers for movie nights' "stream from my device". STUN is enough when two home networks
 * can reach each other directly; viewers on mobile data or strict NATs need a TURN relay. Relay
 * credentials are issued here, short-lived, so no long-term secret ever ships in the website.
 *
 * Configure ONE provider with environment variables:
 *  - Cloudflare Realtime TURN: TURN_CLOUDFLARE_KEY_ID + TURN_CLOUDFLARE_API_TOKEN
 *  - Metered:                  TURN_METERED_DOMAIN (e.g. yourapp.metered.live) + TURN_METERED_API_KEY
 *  - Your own TURN (coturn):   TURN_URLS (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL
 */

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

const STUN: IceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
const CREDENTIAL_TTL_S = 24 * 60 * 60;
/** Refresh well before the credentials expire. */
const CACHE_MS = 6 * 60 * 60 * 1000;

let cached: { servers: IceServer[]; expires: number } | null = null;
let pending: Promise<IceServer[]> | null = null;

const env = (name: string) => process.env[name]?.trim() || undefined;

export function turnProvider(): 'cloudflare' | 'metered' | 'static' | null {
  if (env('TURN_CLOUDFLARE_KEY_ID') && env('TURN_CLOUDFLARE_API_TOKEN')) return 'cloudflare';
  if (env('TURN_METERED_DOMAIN') && env('TURN_METERED_API_KEY')) return 'metered';
  if (env('TURN_URLS')) return 'static';
  return null;
}

async function fetchTurn(): Promise<IceServer[]> {
  switch (turnProvider()) {
    case 'cloudflare': {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env('TURN_CLOUDFLARE_KEY_ID')}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env('TURN_CLOUDFLARE_API_TOKEN')}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: CREDENTIAL_TTL_S }),
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!res.ok) throw new Error(`Cloudflare TURN: HTTP ${res.status}`);
      const body = (await res.json()) as { iceServers?: IceServer | IceServer[] };
      const servers = Array.isArray(body.iceServers) ? body.iceServers : body.iceServers ? [body.iceServers] : [];
      // Cloudflare also lists :53, which many browsers block; drop those entries' URLs.
      return servers.map((s) => ({ ...s, urls: [s.urls].flat().filter((u) => !/:53(\?|$)/.test(u)) }));
    }
    case 'metered': {
      const url = `https://${env('TURN_METERED_DOMAIN')}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env('TURN_METERED_API_KEY')!)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`Metered TURN: HTTP ${res.status}`);
      return (await res.json()) as IceServer[];
    }
    case 'static':
      return [{ urls: env('TURN_URLS')!.split(',').map((u) => u.trim()), username: env('TURN_USERNAME'), credential: env('TURN_CREDENTIAL') }];
    default:
      return [];
  }
}

/** STUN plus (if configured) TURN; cached and de-duplicated. TURN failures fall back to STUN only. */
export async function getIceServers(): Promise<IceServer[]> {
  if (cached && cached.expires > Date.now()) return cached.servers;
  pending ??= fetchTurn()
    .then((turn) => {
      const servers = [...STUN, ...turn];
      cached = { servers, expires: Date.now() + (turn.length ? CACHE_MS : 5 * 60 * 1000) };
      return servers;
    })
    .catch((err) => {
      console.warn('[turn] could not get relay credentials:', (err as Error).message);
      cached = { servers: STUN, expires: Date.now() + 60 * 1000 };
      return STUN;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
