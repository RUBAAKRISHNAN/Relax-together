import type { SuggestedVideo } from '@shared/types';
import { fromLockup, fromVideoRenderer } from './youtubeWatch';
import { BROWSER_HEADERS, extractJson, get, parseClock, walk } from './ytJson';

/** YouTube search (videos only) from the public results page. Cached; failures yield []. */

const MAX_RESULTS = 12;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_LIMIT = 500;
const cache = new Map<string, { results: SuggestedVideo[]; expires: number }>();
const inFlight = new Map<string, Promise<SuggestedVideo[]>>();

/** One retry with a longer timeout: YouTube occasionally stalls a single request. */
async function load(query: string): Promise<SuggestedVideo[]> {
  const first = await attempt(query, 6000);
  return first ?? (await attempt(query, 10_000)) ?? [];
}

async function attempt(query: string, timeoutMs: number): Promise<SuggestedVideo[] | null> {
  try {
    // sp=EgIQAQ%3D%3D is YouTube's own "Type: Video" filter.
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAQ%253D%253D&hl=en&gl=US`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: BROWSER_HEADERS });
    if (!res.ok) return null;
    const data = extractJson(await res.text(), 'ytInitialData');
    const results: SuggestedVideo[] = [];
    const seen = new Set<string>();
    walk(get(data, 'contents'), (key, value) => {
      if (results.length >= MAX_RESULTS) return;
      const item = key === 'videoRenderer' ? fromVideoRenderer(value) : key === 'lockupViewModel' ? fromLockup(value) : null;
      if (item && item.title && !seen.has(item.videoId)) {
        seen.add(item.videoId);
        results.push(item);
      }
    });
    return results;
  } catch (err) {
    console.warn(`[youtube] search "${query}" failed (${timeoutMs} ms):`, (err as Error).message);
    return null;
  }
}

export function searchYouTube(query: string): Promise<SuggestedVideo[]> {
  const key = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return Promise.resolve([]);
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.results);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = load(key).then((results) => {
      inFlight.delete(key);
      if (results.length) {
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(key, { results, expires: Date.now() + CACHE_TTL_MS });
      }
      return results;
    });
    inFlight.set(key, pending);
  }
  return pending;
}

/** Versions people rarely mean when they ask for a song. */
const VARIANT_RE = /\b(live|cover|remix|8d|slowed|reverb|sped ?up|nightcore|karaoke|instrumental|reaction|hours?|extended|mashup|tutorial|lesson|bass ?boosted)\b/i;

/**
 * Picks the YouTube upload that best matches a song: the right length (when known), official
 * audio or "- Topic" channels first, and no covers/remixes/live versions unless asked for.
 */
export function pickBestMatch(results: SuggestedVideo[], query: string, durationSec?: number, artist?: string): SuggestedVideo | null {
  // "The Weeknd, Daft Punk" → "the weeknd": uploads from the artist's own channel are the real thing.
  const mainArtist = artist?.split(/,|&| feat\.? | x /i)[0]?.trim().toLowerCase() ?? '';
  let best: SuggestedVideo | null = null;
  let bestScore = -Infinity;
  results.forEach((r, index) => {
    if (r.isLive) return;
    const length = parseClock(r.duration);
    const title = r.title.toLowerCase();
    let score = -index * 1.5;

    if (durationSec && length) {
      const diff = Math.abs(length - durationSec);
      score += diff <= 5 ? 25 : diff <= 12 ? 18 : diff <= 30 ? 5 : -30;
    } else {
      score += length > 0 && length < 15 * 60 ? 5 : -20;
    }
    if (/official audio/.test(title)) score += 15;
    else if (/\(audio\)|\[audio\]/.test(title)) score += 6;
    else if (/lyric/.test(title)) score += 6;
    else if (/official (music )?video/.test(title)) score += 6;
    if (/ - topic$/i.test(r.author)) score += 18;
    if (mainArtist && r.author.toLowerCase().replace(/ - topic$/, '').includes(mainArtist)) score += 12;
    const variant = title.match(VARIANT_RE)?.[0];
    if (variant && !query.toLowerCase().includes(variant)) score -= 25;

    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  });
  return best;
}

export async function findOnYouTube(query: string, durationSec?: number, artist?: string): Promise<SuggestedVideo | null> {
  return pickBestMatch(await searchYouTube(query), query, durationSec, artist);
}
