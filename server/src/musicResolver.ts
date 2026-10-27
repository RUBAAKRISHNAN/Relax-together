import type { TrackOrigin, VideoMeta } from '@shared/types';
import { parseYouTubeUrl } from '@shared/youtube';
import { fetchVideoMeta } from './oembed';
import { findOnYouTube } from './youtubeSearch';
import { BROWSER_HEADERS, get, isObj, str } from './ytJson';

/**
 * Turns whatever someone pastes in a music room into something playable:
 *  - YouTube / YouTube Music links play directly,
 *  - Spotify tracks, albums and playlists and Apple Music songs/albums are read for title,
 *    artist and length, then matched to the official audio on YouTube,
 *  - links from other music services are read from their page metadata,
 *  - anything else is treated as a search ("blinding lights the weeknd").
 * Streaming services don't allow playback outside their own apps without a per-user login,
 * so matching to YouTube is what lets everyone in the room hear the same song.
 */

export interface PendingTrack {
  title: string;
  author: string;
  thumbnail: string;
  durationSec?: number;
  origin: TrackOrigin;
}

export type Resolved =
  | { kind: 'track'; meta: VideoMeta; startSeconds: number }
  | { kind: 'collection'; name: string; tracks: PendingTrack[] }
  | { kind: 'error'; error: string };

const MAX_COLLECTION = 50;
const NOT_FOUND = "Couldn't find that song on YouTube. Try typing the song name and artist.";

/**
 * Other services we read page metadata from. An allow-list (instead of fetching any URL) keeps
 * the server from being used to probe internal networks.
 */
const KNOWN_MUSIC_HOSTS = [
  'jiosaavn.com',
  'gaana.com',
  'wynk.in',
  'deezer.com',
  'deezer.page.link',
  'soundcloud.com',
  'music.amazon.com',
  'music.amazon.in',
  'tidal.com',
  'audiomack.com',
  'bandcamp.com',
  'hungama.com',
  'anghami.com',
  'boomplay.com',
  'pandora.com',
  'napster.com',
  'shazam.com',
  'last.fm',
];

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    // Redirects must stay on an allowed host too.
    const finalHost = new URL(res.url).hostname.toLowerCase();
    if (!isAllowedFetchHost(finalHost)) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function isAllowedFetchHost(host: string): boolean {
  return (
    hostMatches(host, 'spotify.com') ||
    hostMatches(host, 'apple.com') ||
    KNOWN_MUSIC_HOSTS.some((d) => hostMatches(host, d))
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function metaTag(html: string, name: string): string | undefined {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i');
  const reversed = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i');
  const value = html.match(re)?.[1] ?? html.match(reversed)?.[1];
  return value ? decodeEntities(value).trim() : undefined;
}

async function matchTrack(t: PendingTrack, query?: string): Promise<VideoMeta | null> {
  const q = query ?? `${t.title} ${t.author} audio`;
  const hit = await findOnYouTube(q, t.durationSec, t.author);
  if (!hit) return null;
  return {
    videoId: hit.videoId,
    title: t.title || hit.title,
    author: t.author || hit.author,
    thumbnail: t.thumbnail || hit.thumbnail,
    origin: t.origin,
    durationSec: t.durationSec,
    isLive: false,
  };
}

/** Resolves one pending playlist entry to a playable track. */
export const resolvePending = (t: PendingTrack) => matchTrack(t);

// ---------------------------------------------------------------- Spotify

async function resolveSpotify(url: URL): Promise<Resolved> {
  // Paths look like /track/ID, /album/ID, /playlist/ID, optionally prefixed with /intl-xx/.
  const parts = url.pathname.split('/').filter((p) => p && !p.startsWith('intl-'));
  const [type, id] = parts;
  if (!['track', 'album', 'playlist'].includes(type) || !/^[A-Za-z0-9]{10,40}$/.test(id ?? '')) {
    return { kind: 'error', error: 'Paste a Spotify song, album or playlist link.' };
  }
  const html = await fetchText(`https://open.spotify.com/embed/${type}/${id}`);
  const json = html?.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)?.[1];
  let entity: unknown;
  try {
    entity = json ? get(JSON.parse(json), 'props', 'pageProps', 'state', 'data', 'entity') : null;
  } catch {
    entity = null;
  }
  if (!isObj(entity)) return { kind: 'error', error: "Couldn't read that Spotify link. Is it public?" };

  const images = (get(entity, 'visualIdentity', 'image') as { url?: string; maxWidth?: number }[] | undefined) ?? [];
  const cover = [...images].sort((a, b) => (b.maxWidth ?? 0) - (a.maxWidth ?? 0))[0]?.url ?? '';

  if (type === 'track') {
    const artists = ((entity.artists as { name?: string }[]) ?? []).map((a) => a.name).filter(Boolean).join(', ');
    const pending: PendingTrack = {
      title: str(entity.name || entity.title).slice(0, 200),
      author: artists.slice(0, 100),
      thumbnail: cover,
      durationSec: typeof entity.duration === 'number' ? Math.round(entity.duration / 1000) : undefined,
      origin: 'spotify',
    };
    const meta = await matchTrack(pending);
    return meta ? { kind: 'track', meta, startSeconds: 0 } : { kind: 'error', error: NOT_FOUND };
  }

  const list = (entity.trackList as { title?: string; subtitle?: string; duration?: number }[]) ?? [];
  const tracks = list
    .filter((t) => t.title)
    .slice(0, MAX_COLLECTION)
    .map<PendingTrack>((t) => ({
      title: str(t.title).slice(0, 200),
      author: str(t.subtitle).slice(0, 100),
      // Album tracks share the album art; playlist tracks get their YouTube thumbnail once matched.
      thumbnail: type === 'album' ? cover : '',
      durationSec: typeof t.duration === 'number' ? Math.round(t.duration / 1000) : undefined,
      origin: 'spotify',
    }));
  if (!tracks.length) return { kind: 'error', error: 'That Spotify list is empty or private.' };
  return { kind: 'collection', name: str(entity.name || entity.title) || 'Spotify list', tracks };
}

// ---------------------------------------------------------------- Apple Music

interface ItunesResult {
  wrapperType?: string;
  kind?: string;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
}

async function resolveApple(url: URL): Promise<Resolved> {
  // /us/song/slug/123, /us/album/slug/456?i=123 (a song on an album) or /us/album/slug/456.
  const country = url.pathname.split('/').filter(Boolean)[0]?.match(/^[a-z]{2}$/)?.[0] ?? 'us';
  const trackId = url.searchParams.get('i') ?? (url.pathname.includes('/song/') ? url.pathname.match(/(\d+)\/?$/)?.[1] : null);
  const albumId = url.pathname.includes('/album/') ? url.pathname.match(/(\d+)\/?$/)?.[1] : null;
  if (!trackId && !albumId) {
    return { kind: 'error', error: 'Paste an Apple Music song or album link (playlists aren’t supported yet).' };
  }

  const lookup = trackId
    ? `https://itunes.apple.com/lookup?id=${trackId}&country=${country}`
    : `https://itunes.apple.com/lookup?id=${albumId}&entity=song&limit=${MAX_COLLECTION}&country=${country}`;
  let results: ItunesResult[] = [];
  try {
    const res = await fetch(lookup, { signal: AbortSignal.timeout(7000) });
    results = ((await res.json()) as { results?: ItunesResult[] }).results ?? [];
  } catch {
    /* handled below */
  }
  const toPending = (r: ItunesResult): PendingTrack => ({
    title: str(r.trackName).slice(0, 200),
    author: str(r.artistName).slice(0, 100),
    thumbnail: r.artworkUrl100?.replace('100x100bb', '600x600bb') ?? '',
    durationSec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : undefined,
    origin: 'apple',
  });

  const songs = results.filter((r) => r.wrapperType === 'track' && r.trackName);
  if (trackId) {
    if (!songs[0]) return { kind: 'error', error: "Couldn't read that Apple Music song." };
    const meta = await matchTrack(toPending(songs[0]));
    return meta ? { kind: 'track', meta, startSeconds: 0 } : { kind: 'error', error: NOT_FOUND };
  }
  if (!songs.length) return { kind: 'error', error: "Couldn't read that Apple Music album." };
  return { kind: 'collection', name: results[0]?.collectionName ?? 'Apple Music album', tracks: songs.map(toPending) };
}

// ---------------------------------------------------------------- other services

const SITE_NOISE = /jiosaavn|gaana|wynk|spotify|deezer|soundcloud|amazon|tidal|audiomack|bandcamp|hungama|anghami|boomplay|pandora|napster|shazam|last\.?fm|apple music|download|listen|free|online|mp3|stream|lyrics/i;

async function resolveGenericLink(url: URL): Promise<Resolved> {
  const html = await fetchText(url.toString());
  if (!html) return { kind: 'error', error: "Couldn't open that link." };
  const rawTitle = metaTag(html, 'og:title') ?? decodeEntities(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '');
  // "Houdini (Full Song) - Dua Lipa - Download or Listen Free - JioSaavn" → ["Houdini", "Dua Lipa"]
  const parts = rawTitle
    .split(/\s+[-|–—·]\s+|\s+by\s+/i)
    .map((p) => p.replace(/\((full song|official.*?|from .*?)\)/gi, '').trim())
    .filter((p) => p && !SITE_NOISE.test(p));
  if (!parts.length) return { kind: 'error', error: "Couldn't read a song from that link. Try the song name instead." };

  const duration = Number(metaTag(html, 'music:duration'));
  const pending: PendingTrack = {
    title: parts[0].slice(0, 200),
    author: (parts[1] ?? '').slice(0, 100),
    thumbnail: metaTag(html, 'og:image') ?? '',
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    origin: 'link',
  };
  const meta = await matchTrack(pending, `${parts.slice(0, 2).join(' ')} audio`);
  return meta ? { kind: 'track', meta, startSeconds: 0 } : { kind: 'error', error: NOT_FOUND };
}

// ---------------------------------------------------------------- entry point

function asUrl(input: string): URL | null {
  const looksLikeUrl = /^https?:\/\//i.test(input) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(input);
  if (!looksLikeUrl || /\s/.test(input)) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

export async function resolveMusic(rawInput: string): Promise<Resolved> {
  const input = rawInput.trim();
  if (!input) return { kind: 'error', error: 'Type a song name or paste a link.' };

  const url = asUrl(input);
  if (url) {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (/(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$/.test(host)) {
      const parsed = parseYouTubeUrl(input);
      if (!parsed.ok) return { kind: 'error', error: parsed.error };
      const meta = await fetchVideoMeta(parsed.videoId);
      if (!meta.ok) return { kind: 'error', error: meta.error };
      return { kind: 'track', meta: { ...meta.meta, origin: 'youtube' }, startSeconds: parsed.startSeconds };
    }
    if (hostMatches(host, 'spotify.com')) return resolveSpotify(url);
    if (hostMatches(host, 'music.apple.com') || hostMatches(host, 'itunes.apple.com')) return resolveApple(url);
    if (KNOWN_MUSIC_HOSTS.some((d) => hostMatches(host, d))) return resolveGenericLink(url);
    return {
      kind: 'error',
      error: "That link isn't from a music service we know. Paste a Spotify, Apple Music or YouTube link, or type the song name.",
    };
  }

  // A bare 11-character id is almost always a YouTube video id.
  if (/^[A-Za-z0-9_-]{11}$/.test(input) && /[A-Z0-9_-]/.test(input) && /[a-z]/.test(input)) {
    const meta = await fetchVideoMeta(input);
    if (meta.ok) return { kind: 'track', meta: { ...meta.meta, origin: 'youtube' }, startSeconds: 0 };
  }

  const hit = await findOnYouTube(input);
  if (!hit) return { kind: 'error', error: `No songs found for “${input.slice(0, 60)}”.` };
  return {
    kind: 'track',
    meta: { videoId: hit.videoId, title: hit.title, author: hit.author, thumbnail: hit.thumbnail, origin: 'search', isLive: false },
    startSeconds: 0,
  };
}
