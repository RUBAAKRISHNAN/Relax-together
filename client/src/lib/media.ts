import type { TrackOrigin } from '@shared/types';
import { SERVER_URL } from './env';

/** Uploaded cover art comes back as a server path ("/media/..."); make it absolute. */
export function assetUrl(url: string | undefined | null): string {
  if (!url) return '';
  return url.startsWith('/') ? `${SERVER_URL}${url}` : url;
}

export const uploadedFileUrl = (roomId: string, fileId: string) => `${SERVER_URL}/media/${roomId}/${fileId}`;

export const ORIGIN_LABELS: Record<TrackOrigin, string> = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  apple: 'Apple Music',
  link: 'Music link',
  search: 'Search',
  upload: 'Uploaded',
};

/** Brand-ish badge colors so people can tell at a glance where a song came from. */
export const ORIGIN_STYLES: Record<TrackOrigin, string> = {
  youtube: 'bg-red-500/15 text-red-600 dark:text-red-300',
  spotify: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  apple: 'bg-pink-500/15 text-pink-600 dark:text-pink-300',
  link: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  search: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  upload: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
};
