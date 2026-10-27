import type { VideoMeta } from '@shared/types';
import { thumbnailFor } from '@shared/youtube';

type MetaResult = { ok: true; meta: VideoMeta } | { ok: false; error: string };

const cache = new Map<string, VideoMeta>();
const CACHE_LIMIT = 500;

/**
 * Looks up title/author through YouTube's oEmbed endpoint (no API key needed).
 * oEmbed also tells us when a video is private or has embedding disabled, so we can
 * reject it up front instead of showing everyone a broken player.
 */
export async function fetchVideoMeta(videoId: string): Promise<MetaResult> {
  const cached = cache.get(videoId);
  if (cached) return { ok: true, meta: cached };

  const fallback: VideoMeta = { videoId, title: 'YouTube video', author: '', thumbnail: thumbnailFor(videoId) };
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "This video is private or its owner doesn't allow embedding." };
    }
    if (res.status === 400 || res.status === 404) {
      return { ok: false, error: 'Video not found. It may have been removed.' };
    }
    if (!res.ok) return { ok: true, meta: fallback };

    const data = (await res.json()) as { title?: unknown; author_name?: unknown };
    const meta: VideoMeta = {
      videoId,
      title: typeof data.title === 'string' && data.title ? data.title.slice(0, 200) : fallback.title,
      author: typeof data.author_name === 'string' ? data.author_name.slice(0, 100) : '',
      thumbnail: fallback.thumbnail,
    };
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(videoId, meta);
    return { ok: true, meta };
  } catch {
    // Network trouble shouldn't block playback; the player itself will report truly broken videos.
    return { ok: true, meta: fallback };
  }
}
