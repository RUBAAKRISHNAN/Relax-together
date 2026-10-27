export const ROOM_CODE_LENGTH = 6;
/** No 0/O/1/I to avoid confusion when codes are read aloud. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export const MAX_CHAT_LENGTH = 500;
export const MAX_NAME_LENGTH = 24;
export const MAX_QUEUE_LENGTH = 50;
export const MAX_MEMBERS = 50;
export const CHAT_HISTORY_LIMIT = 100;
/** Upper bound for a video position. Large on purpose: 24/7 live streams report positions in the millions of seconds. */
export const MAX_VIDEO_TIME = 1_000_000_000;

/** Room is deleted this long after the last member leaves. */
export const ROOM_EMPTY_TTL_MS = 10 * 60 * 1000;
/** A disconnected member is kept (shown offline) this long so quick reconnects are seamless. */
export const MEMBER_GRACE_MS = 5000;

/** Shared "vibe" environments for music rooms. Display details live in the client. */
export const MOOD_IDS = ['calm', 'rain', 'night', 'sunset', 'forest', 'ocean', 'party'] as const;
export type MoodId = (typeof MOOD_IDS)[number];

/** Uploaded music limits. */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const UPLOAD_MAX_FILES_PER_ROOM = 40;
export const UPLOAD_MAX_BYTES_PER_ROOM = 500 * 1024 * 1024;
/** Uploaded tracks use this prefix in place of a YouTube video id. */
export const FILE_SOURCE_PREFIX = 'file:';
export const isFileSource = (id: string | null | undefined): id is string => !!id && id.startsWith(FILE_SOURCE_PREFIX);

/** Movies use this prefix in place of a YouTube video id. */
export const MOVIE_SOURCE_PREFIX = 'movie:';
export const isMovieSource = (id: string | null | undefined): id is string => !!id && id.startsWith(MOVIE_SOURCE_PREFIX);
/** Shared subtitle files (SRT/VTT) are sent over the socket, so keep them modest. */
export const SUBTITLE_MAX_CHARS = 800_000;

export const REACTION_EMOJIS = ['❤️', '😂', '🔥', '😮', '👏'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export const SYNC = {
  /** Host broadcasts its position this often. */
  HEARTBEAT_MS: 3000,
  /** Viewers check drift this often. */
  DRIFT_CHECK_MS: 1000,
  /** Drift above this (seconds) triggers a hard seek. */
  HARD_SEEK_THRESHOLD: 1.0,
  /** Drift above this (seconds) triggers a playback-rate nudge. */
  NUDGE_THRESHOLD: 0.3,
  /** A nudge stops once drift is below this. */
  CAUGHT_UP_THRESHOLD: 0.08,
  CLOCK_SAMPLES: 5,
  CLOCK_RESYNC_MS: 30_000,
} as const;

/** Accepts a raw code ("abc123") or an invite link (".../room/ABC123") and returns the normalized code. */
export function normalizeRoomCode(input: string): string | null {
  const trimmed = input.trim();
  const fromLink = trimmed.match(/\/room\/([A-Za-z0-9]+)/);
  const candidate = (fromLink ? fromLink[1] : trimmed).toUpperCase();
  return ROOM_CODE_RE.test(candidate) ? candidate : null;
}
