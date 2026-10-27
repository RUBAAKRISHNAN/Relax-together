const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type ParsedVideo =
  | { ok: true; videoId: string; startSeconds: number }
  | { ok: false; error: string };

const fail = (error: string): ParsedVideo => ({ ok: false, error });

/** Parses "90", "90s", "1m30s", "1h2m3s" into seconds. */
export function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const v = value.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.floor(Number(v));
  const m = v.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m || !m[0]) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * Extracts a video id (and optional start time) from any common YouTube URL:
 * watch?v=, youtu.be/, /shorts/, /embed/, /live/, mobile/music hosts, and
 * links carrying timestamps or playlist params. A bare 11-char id also works.
 */
export function parseYouTubeUrl(input: string): ParsedVideo {
  const raw = input.trim();
  if (!raw) return fail('Paste a YouTube link first.');
  if (VIDEO_ID_RE.test(raw)) return { ok: true, videoId: raw, startSeconds: 0 };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return fail("That doesn't look like a valid link.");
  }

  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|music\.)/, '');
  const parts = url.pathname.split('/').filter(Boolean);
  let id: string | null = null;

  if (host === 'youtu.be') {
    id = parts[0] ?? null;
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (parts.length === 0 || parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v', 'e'].includes(parts[0])) id = parts[1] ?? null;
    if (!id && url.searchParams.has('list')) {
      return fail('Playlist links need a specific video. Open a video from the playlist and copy its link.');
    }
  } else {
    return fail('Only YouTube links are supported.');
  }

  if (!id || !VIDEO_ID_RE.test(id)) return fail("Couldn't find a video in that link.");

  const hashT = url.hash.match(/t=([^&]+)/)?.[1];
  const start = parseTimestamp(url.searchParams.get('t') ?? url.searchParams.get('start') ?? hashT);
  return { ok: true, videoId: id, startSeconds: start };
}

export const thumbnailFor = (videoId: string) => `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
