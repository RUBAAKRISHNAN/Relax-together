import type { MoodId, ReactionEmoji } from './constants';

export type UserId = string;

/** Experiences offered on the home dashboard. Only YouTube is live so far. */
export type ExperienceMode = 'youtube' | 'music' | 'movies';

export interface Member {
  id: UserId;
  name: string;
  /** Avatar color (hex), derived from the user id. */
  color: string;
  joinedAt: number;
  online: boolean;
}

/** Where a track came from (shown as a badge in music rooms). */
export type TrackOrigin = 'youtube' | 'spotify' | 'apple' | 'link' | 'search' | 'upload';

/**
 * A playable item. `videoId` is a YouTube id, or `file:<id>` for an uploaded track.
 * `thumbnail` may be a path on our server (starting with "/") for uploaded cover art.
 */
export interface VideoMeta {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  isLive?: boolean;
  origin?: TrackOrigin;
  album?: string;
  durationSec?: number;
  /** Movie rooms: where the picture comes from. */
  movie?: MovieSource;
}

/**
 * How a movie room plays its movie:
 *  - local:  everyone opens their own copy of the same file (zero streaming lag, full quality);
 *            `fingerprint` lets each person check they have the same version.
 *  - url:    everyone streams a direct video link (MP4/WebM or an HLS .m3u8 playlist).
 *  - stream: the host's browser streams its copy to everyone peer-to-peer (WebRTC).
 */
export type MovieSource =
  | { kind: 'local'; name: string; size: number; fingerprint: string; duration: number }
  | { kind: 'url'; name: string; url: string }
  | { kind: 'stream'; name: string; size: number; fingerprint: string; duration: number };

/** Each member's readiness for the current movie (shown in the ready check). */
export type MovieReadyState = 'ready' | 'missing' | 'mismatch' | 'error';

export interface SubtitleTrack {
  name: string;
  /** Raw SRT or WebVTT text. */
  text: string;
}

/**
 * What the socket announces about shared subtitles. The text itself travels over HTTP
 * (GET /api/rooms/:id/subtitles): hosting proxies drop large WebSocket messages.
 */
export interface SubtitleInfo {
  name: string;
  version: number;
}

/** Same shape as the DOM's RTCIceCandidateInit (redeclared because the server has no DOM types). */
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** WebRTC signalling relayed between the host and a viewer for "stream from my device". */
export type RtcSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: IceCandidate }
  /** A viewer asking the host for a (new) offer, e.g. after joining mid-stream. */
  | { type: 'hello' }
  | { type: 'bye' };

/** A "suggested next" video, taken from YouTube's own recommendations for the current video. */
export interface SuggestedVideo {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
  /** Duration badge text, e.g. "12:34"; null for live streams. */
  duration: string | null;
  isLive: boolean;
  /** Secondary line such as "1.2M views · 3 days ago" or "5.6K watching". */
  meta: string;
}

export interface MusicSearchResponse {
  query: string;
  results: SuggestedVideo[];
}

export interface UploadResponse {
  track: VideoMeta;
  /** "playing" when nothing was playing, so the upload started right away. */
  placement: 'playing' | 'queued';
}

export interface SuggestionsResponse {
  videoId: string;
  isLive: boolean;
  suggestions: SuggestedVideo[];
}

/** Authoritative playback state, owned by the server. */
export interface PlaybackState {
  videoId: string | null;
  isPlaying: boolean;
  /** Video position (seconds) at `lastUpdatedAt`. */
  currentTime: number;
  /** Server timestamp (ms) at which `currentTime` was true. */
  lastUpdatedAt: number;
  playbackRate: number;
}

export interface QueueItem {
  id: string;
  video: VideoMeta;
  /** Songs imported from a playlist are matched to YouTube in the background. */
  status?: 'resolving' | 'failed';
  startSeconds: number;
  addedBy: { id: UserId; name: string };
  addedAt: number;
}

export interface ChatMessage {
  id: string;
  userId: UserId;
  name: string;
  color: string;
  text: string;
  sentAt: number;
}

export interface RoomSnapshot {
  roomId: string;
  mode: ExperienceMode;
  hostId: UserId | null;
  /** When the queue runs out, continue with YouTube's top suggestion. */
  autoplay: boolean;
  /** Music rooms: the shared environment everyone sees. */
  mood: MoodId;
  /** Movie rooms: who has the current movie loaded and ready. */
  movieReady: Record<UserId, MovieReadyState>;
  members: Member[];
  queue: QueueItem[];
  playback: PlaybackState;
  video: VideoMeta | null;
}

export type SyncAction = 'play' | 'pause' | 'seek' | 'load' | 'heartbeat' | 'state';

/**
 * Broadcast whenever playback changes. Clients derive the live position as
 * expectedTime = videoTime + (serverNow - serverTimestamp) / 1000 * playbackRate (while playing).
 */
export interface SyncEvent {
  action: SyncAction;
  videoId: string | null;
  isPlaying: boolean;
  videoTime: number;
  serverTimestamp: number;
  playbackRate: number;
  by: UserId | null;
}

export interface ReactionEvent {
  id: string;
  emoji: ReactionEmoji;
  userId: UserId;
  name: string;
}

export type NoticeKind = 'joined' | 'left' | 'host' | 'video' | 'info';

export interface RoomNotice {
  kind: NoticeKind;
  text: string;
}

export interface JoinResult {
  selfId: UserId;
  snapshot: RoomSnapshot;
  messages: ChatMessage[];
}

export type ErrorCode = 'ROOM_NOT_FOUND' | 'FORBIDDEN' | 'RATE_LIMITED' | 'INVALID';

export type AckResponse<T = null> = { ok: true; data: T } | { ok: false; error: string; code?: ErrorCode };

export type Ack<T = null> = (res: AckResponse<T>) => void;

export interface ClientToServerEvents {
  'time:ping': (ack: (serverTime: number) => void) => void;
  'room:join': (p: { roomId: string; userId: UserId; name: string }, ack: Ack<JoinResult>) => void;
  'room:leave': (ack?: Ack) => void;
  'player:command': (
    p: { action: 'play' | 'pause' | 'seek'; videoTime: number; sentAt: number },
    ack?: Ack<SyncEvent>,
  ) => void;
  'player:heartbeat': (p: { videoTime: number; isPlaying: boolean; sentAt: number }) => void;
  'player:load': (p: { url: string }, ack: Ack) => void;
  'queue:add': (p: { url: string }, ack: Ack) => void;
  'queue:remove': (p: { itemId: string }, ack: Ack) => void;
  'queue:play': (p: { itemId: string }, ack: Ack) => void;
  'queue:next': (ack: Ack) => void;
  'host:transfer': (p: { userId: UserId }, ack: Ack) => void;
  'room:autoplay': (p: { enabled: boolean }, ack: Ack) => void;
  'room:mood': (p: { mood: MoodId }, ack: Ack) => void;
  'movie:load': (p: { source: MovieSource }, ack: Ack) => void;
  'movie:ready': (p: { videoId: string; state: MovieReadyState }) => void;
  /** Sharing goes over HTTP (POST /api/rooms/:id/subtitles); this only removes them. */
  'movie:clearSubtitles': (ack: Ack) => void;
  'rtc:signal': (p: { to: UserId; signal: RtcSignal }) => void;
  /** Short-lived permission for HTTP uploads into the room (songs, subtitles). */
  'room:uploadToken': (ack: Ack<{ token: string; expiresAt: number }>) => void;
  'chat:send': (p: { text: string }, ack: Ack) => void;
  'reaction:send': (p: { emoji: ReactionEmoji }) => void;
}

export interface ServerToClientEvents {
  'room:state': (snapshot: RoomSnapshot) => void;
  'room:notice': (notice: RoomNotice) => void;
  'room:closed': (p: { reason: string }) => void;
  'movie:subtitles': (info: SubtitleInfo | null) => void;
  'rtc:signal': (p: { from: UserId; signal: RtcSignal }) => void;
  'player:sync': (ev: SyncEvent) => void;
  'chat:message': (msg: ChatMessage) => void;
  reaction: (ev: ReactionEvent) => void;
}

export interface SocketData {
  roomId?: string;
  userId?: UserId;
}
