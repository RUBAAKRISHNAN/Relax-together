import type { VideoMeta } from '@shared/types';

/**
 * Movie files opened on this device, kept for the whole visit (they can't survive a page refresh:
 * browsers don't let a page reopen a file by itself). Files are found by fingerprint, so a movie
 * the host loads again later is recognised, and by room movie id for a "different version" copy.
 */
const byFingerprint = new Map<string, { file: File; url: string }>();
const byMovieId = new Map<string, { file: File; url: string }>();
/** Per movie: a copy of the file re-headered to play the audio language this person picked. */
const audioVariants = new Map<string, string>();

function entry(file: File) {
  return { file, url: URL.createObjectURL(file) };
}

export function rememberFile(fingerprint: string, file: File) {
  if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, entry(file));
}

/** A copy that doesn't match the host's fingerprint, used for this movie anyway. */
export function rememberFileForMovie(movieId: string, file: File) {
  const old = byMovieId.get(movieId);
  if (old) URL.revokeObjectURL(old.url);
  byMovieId.set(movieId, entry(file));
}

export function localCopy(video: VideoMeta | null | undefined): { file: File; url: string } | null {
  const movie = video?.movie;
  if (!video || !movie || movie.kind === 'url') return null;
  const base = byFingerprint.get(movie.fingerprint) ?? byMovieId.get(video.videoId) ?? null;
  const variant = audioVariants.get(video.videoId);
  return base && variant ? { file: base.file, url: variant } : base;
}

/** Play this movie with a different audio language (a Blob from audioTracks.withAudio). */
export function setAudioVariant(movieId: string, blob: Blob) {
  const old = audioVariants.get(movieId);
  if (old) URL.revokeObjectURL(old);
  audioVariants.set(movieId, URL.createObjectURL(blob));
}

export const MOVIE_ACCEPT = 'video/*,.mp4,.m4v,.webm,.mkv,.mov,.ogv';
