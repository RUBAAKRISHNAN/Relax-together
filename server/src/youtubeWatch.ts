import type { SuggestedVideo } from '@shared/types';
import { BROWSER_HEADERS, type Json, extractJson, get, str, text, walk } from './ytJson';

/**
 * Reads YouTube's public watch page to learn (a) whether a video is live and (b) YouTube's own
 * "up next" recommendations. The Data API no longer offers related videos (and needs a key),
 * so this mirrors what a logged-out browser sees. The page format changes from time to time,
 * so parsing is defensive and supports both the current `lockupViewModel` items and the older
 * `compactVideoRenderer` ones. Any failure simply yields no suggestions.
 */

export interface WatchInfo {
  isLive: boolean;
  suggestions: SuggestedVideo[];
}

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_SUGGESTIONS = 20;
const CACHE_TTL_MS = 10 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_LIMIT = 300;

const cache = new Map<string, { info: WatchInfo; expires: number }>();
const inFlight = new Map<string, Promise<WatchInfo | null>>();

export function fromLockup(v: Json): SuggestedVideo | null {
  if (v.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null; // skip mixes / playlists
  const videoId = str(v.contentId);
  if (!VIDEO_ID_RE.test(videoId)) return null;
  const meta = get(v, 'metadata', 'lockupMetadataViewModel');
  const rows = get(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows');
  const rowText = (row: unknown) =>
    ((get(row, 'metadataParts') as unknown[]) ?? []).map((p) => text(get(p, 'text'))).filter(Boolean).join(' · ');

  let duration: string | null = null;
  let isLive = false;
  walk(v.contentImage, (key, badge) => {
    if (key !== 'thumbnailBadgeViewModel') return;
    if (badge.badgeStyle === 'THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE') isLive = true;
    else if (!duration && /^\d+(:\d{2})+$/.test(str(badge.text))) duration = str(badge.text);
  });

  return {
    videoId,
    title: text(get(meta, 'title')).slice(0, 200),
    author: Array.isArray(rows) ? rowText(rows[0]).slice(0, 100) : '',
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration: isLive ? null : duration,
    isLive,
    meta: Array.isArray(rows) ? rows.slice(1).map(rowText).filter(Boolean).join(' · ').slice(0, 100) : '',
  };
}

/** Older related-video items, and the item shape used on search result pages (`videoRenderer`). */
export function fromVideoRenderer(v: Json): SuggestedVideo | null {
  const videoId = str(v.videoId);
  if (!VIDEO_ID_RE.test(videoId)) return null;
  const isLive = JSON.stringify(v.badges ?? '').includes('LIVE') || JSON.stringify(v.thumbnailOverlays ?? '').includes('"LIVE"');
  const duration = text(v.lengthText) || null;
  return {
    videoId,
    title: text(v.title).slice(0, 200),
    author: text(v.longBylineText || v.ownerText || v.shortBylineText).slice(0, 100),
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration: isLive ? null : duration,
    isLive: isLive || !duration,
    meta: [text(v.viewCountText), text(v.publishedTimeText)].filter(Boolean).join(' · ').slice(0, 100),
  };
}

export function parseWatchPage(html: string, videoId: string): WatchInfo {
  const player = extractJson(html, 'ytInitialPlayerResponse');
  const data = extractJson(html, 'ytInitialData');
  const isLive = get(player, 'videoDetails', 'isLive') === true;

  const seen = new Set([videoId]);
  const suggestions: SuggestedVideo[] = [];
  const secondary = get(data, 'contents', 'twoColumnWatchNextResults', 'secondaryResults');
  walk(secondary, (key, value) => {
    if (suggestions.length >= MAX_SUGGESTIONS) return;
    const item = key === 'lockupViewModel' ? fromLockup(value) : key === 'compactVideoRenderer' ? fromVideoRenderer(value) : null;
    if (item && item.title && !seen.has(item.videoId)) {
      seen.add(item.videoId);
      suggestions.push(item);
    }
  });
  return { isLive, suggestions };
}

/** One retry with a longer timeout: YouTube occasionally stalls (or briefly refuses) a request. */
async function load(videoId: string): Promise<WatchInfo | null> {
  return (await attempt(videoId, 6000)) ?? (await attempt(videoId, 10_000));
}

async function attempt(videoId: string, timeoutMs: number): Promise<WatchInfo | null> {
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en&gl=US`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: BROWSER_HEADERS,
    });
    if (!res.ok) {
      console.warn(`[youtube] watch page for ${videoId}: HTTP ${res.status}`);
      return null;
    }
    const html = await res.text();
    const info = parseWatchPage(html, videoId);
    // A consent or "confirm you're not a bot" page parses to nothing; treat it as a failure.
    if (!info.suggestions.length && !html.includes('ytInitialData')) {
      console.warn(`[youtube] watch page for ${videoId}: no page data (blocked or consent page)`);
      return null;
    }
    return info;
  } catch (err) {
    console.warn(`[youtube] watch page for ${videoId} failed (${timeoutMs} ms):`, (err as Error).message);
    return null;
  }
}

/** Cached and de-duplicated: concurrent callers for the same video share one request. */
export function fetchWatchInfo(videoId: string): Promise<WatchInfo | null> {
  if (!VIDEO_ID_RE.test(videoId)) return Promise.resolve(null);
  const hit = cache.get(videoId);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.info);

  let pending = inFlight.get(videoId);
  if (!pending) {
    pending = load(videoId).then((info) => {
      inFlight.delete(videoId);
      if (info) {
        if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        cache.set(videoId, { info, expires: Date.now() + (info.isLive ? LIVE_CACHE_TTL_MS : CACHE_TTL_MS) });
      }
      return info;
    });
    inFlight.set(videoId, pending);
  }
  return pending;
}
