import { randomInt } from 'node:crypto';
import { type MoodId, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, ROOM_EMPTY_TTL_MS } from '@shared/constants';
import type {
  ChatMessage,
  ExperienceMode,
  Member,
  MovieReadyState,
  PlaybackState,
  QueueItem,
  RoomSnapshot,
  SubtitleTrack,
  SyncAction,
  SyncEvent,
  UserId,
  VideoMeta,
} from '@shared/types';

export interface ServerMember extends Member {
  socketId: string | null;
  removalTimer: NodeJS.Timeout | null;
}

export interface Room {
  id: string;
  mode: ExperienceMode;
  hostId: UserId | null;
  autoplay: boolean;
  mood: MoodId;
  /** Movie rooms: readiness per member for the current movie, and the shared subtitles. */
  movieReady: Map<UserId, MovieReadyState>;
  subtitles: SubtitleTrack | null;
  /** Insertion order == join order, which makes "oldest member" lookups trivial. */
  members: Map<UserId, ServerMember>;
  playback: PlaybackState;
  video: VideoMeta | null;
  queue: QueueItem[];
  messages: ChatMessage[];
  createdAt: number;
  deleteTimer: NodeJS.Timeout | null;
}

const AVATAR_COLORS = ['#8b5cf6', '#ec4899', '#f97316', '#10b981', '#06b6d4', '#3b82f6', '#eab308', '#ef4444', '#14b8a6', '#a855f7'];

export function colorFor(userId: string): string {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export class RoomStore {
  private rooms = new Map<string, Room>();

  /** `onDelete` lets other stores (e.g. uploads) clean up after a room. */
  constructor(private onDelete?: (roomId: string) => void) {}

  get size() {
    return this.rooms.size;
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  create(mode: ExperienceMode = 'youtube'): Room {
    let id: string;
    do {
      id = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(id));

    const now = Date.now();
    const room: Room = {
      id,
      mode,
      hostId: null,
      autoplay: true,
      mood: 'calm',
      movieReady: new Map(),
      subtitles: null,
      members: new Map(),
      playback: { videoId: null, isPlaying: false, currentTime: 0, lastUpdatedAt: now, playbackRate: 1 },
      video: null,
      queue: [],
      messages: [],
      createdAt: now,
      deleteTimer: null,
    };
    this.rooms.set(id, room);
    // A room nobody ever joins is cleaned up like an empty one.
    this.scheduleDeletionIfEmpty(room);
    return room;
  }

  scheduleDeletionIfEmpty(room: Room) {
    if (room.members.size > 0 || room.deleteTimer) return;
    room.deleteTimer = setTimeout(() => {
      if (room.members.size === 0) {
        this.rooms.delete(room.id);
        this.onDelete?.(room.id);
        console.log(`[rooms] deleted empty room ${room.id} (${this.rooms.size} active)`);
      }
    }, ROOM_EMPTY_TTL_MS);
    room.deleteTimer.unref();
  }

  cancelDeletion(room: Room) {
    if (room.deleteTimer) clearTimeout(room.deleteTimer);
    room.deleteTimer = null;
  }
}

/** Live position of the authoritative playback state at server time `now`. */
export function positionAt(p: PlaybackState, now = Date.now()): number {
  return p.isPlaying ? p.currentTime + ((now - p.lastUpdatedAt) / 1000) * p.playbackRate : p.currentTime;
}

export function toSyncEvent(room: Room, action: SyncAction, by: UserId | null): SyncEvent {
  const p = room.playback;
  return {
    action,
    videoId: p.videoId,
    isPlaying: p.isPlaying,
    videoTime: p.currentTime,
    serverTimestamp: p.lastUpdatedAt,
    playbackRate: p.playbackRate,
    by,
  };
}

export function toSnapshot(room: Room): RoomSnapshot {
  return {
    roomId: room.id,
    mode: room.mode,
    hostId: room.hostId,
    autoplay: room.autoplay,
    mood: room.mood,
    movieReady: Object.fromEntries(room.movieReady),
    members: [...room.members.values()].map(({ id, name, color, joinedAt, online }) => ({ id, name, color, joinedAt, online })),
    queue: room.queue,
    playback: { ...room.playback },
    video: room.video,
  };
}

/** Oldest member that is currently connected, excluding `exclude`. */
export function nextHostCandidate(room: Room, exclude?: UserId): ServerMember | undefined {
  for (const m of room.members.values()) {
    if (m.id !== exclude && m.online) return m;
  }
  return undefined;
}
