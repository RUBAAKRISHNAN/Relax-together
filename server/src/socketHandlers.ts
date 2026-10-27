import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { CHAT_HISTORY_LIMIT, MAX_MEMBERS, MAX_QUEUE_LENGTH, MEMBER_GRACE_MS, MOVIE_SOURCE_PREFIX } from '@shared/constants';
import type {
  AckResponse,
  ClientToServerEvents,
  ErrorCode,
  MovieSource,
  QueueItem,
  ServerToClientEvents,
  SocketData,
  SyncAction,
  UserId,
  VideoMeta,
} from '@shared/types';
import { parseYouTubeUrl, thumbnailFor } from '@shared/youtube';
import { type PendingTrack, resolveMusic, resolvePending } from './musicResolver';
import { fetchVideoMeta } from './oembed';
import { RateLimiter, SOCKET_LIMITS } from './rateLimiter';
import {
  type Room,
  type RoomStore,
  type ServerMember,
  colorFor,
  nextHostCandidate,
  toSnapshot,
  toSyncEvent,
} from './roomStore';
import type { UploadStore } from './uploads';
import { schemas } from './validation';
import { fetchWatchInfo } from './youtubeWatch';

type IO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

const ok = <T>(data: T): AckResponse<T> => ({ ok: true, data });
const fail = (error: string, code?: ErrorCode): AckResponse<never> => ({ ok: false, error, code });

/** Acks are optional and come from untrusted clients, so only call them if they're real functions. */
function reply(ack: unknown, res: AckResponse<unknown>) {
  if (typeof ack === 'function') ack(res);
}

/**
 * Host timestamps are the host's estimate of server time when it sampled the player.
 * That's more precise than our receive time (it excludes upload latency), but we clamp it
 * so a bad clock can never move the shared state by more than a second.
 */
function stamp(sentAt: number, now: number): number {
  return Math.min(now, Math.max(now - 1000, sentAt));
}

/** What a pasted link / search / upload turned into. */
type Resolution =
  | { ok: true; tracks: { meta: VideoMeta; startSeconds: number }[]; pending: PendingTrack[]; listName?: string }
  | { ok: false; error: string };

/** Playlist entries still waiting to be matched to YouTube (server-only, never sent to clients). */
const pendingTracks = new WeakMap<QueueItem, PendingTrack>();

export function registerSocketHandlers(io: IO, store: RoomStore, uploads: UploadStore) {
  const broadcastState = (room: Room) => io.to(room.id).emit('room:state', toSnapshot(room));

  /** Video rooms accept YouTube links only; music rooms also take other services, searches and uploads. */
  async function resolveInput(room: Room, input: string): Promise<Resolution> {
    if (room.mode !== 'music') {
      const video = parseYouTubeUrl(input);
      if (!video.ok) return { ok: false, error: video.error };
      const meta = await fetchVideoMeta(video.videoId);
      return meta.ok
        ? { ok: true, tracks: [{ meta: meta.meta, startSeconds: video.startSeconds }], pending: [] }
        : { ok: false, error: meta.error };
    }
    const upload = uploads.getBySource(room.id, input.trim());
    if (upload) return { ok: true, tracks: [{ meta: upload.meta, startSeconds: 0 }], pending: [] };

    const resolved = await resolveMusic(input);
    if (resolved.kind === 'error') return { ok: false, error: resolved.error };
    if (resolved.kind === 'track') return { ok: true, tracks: [{ meta: resolved.meta, startSeconds: resolved.startSeconds }], pending: [] };
    return { ok: true, tracks: [], pending: resolved.tracks, listName: resolved.name };
  }

  function makeQueueItem(member: ServerMember, meta: VideoMeta, startSeconds = 0): QueueItem {
    return { id: randomUUID(), video: meta, startSeconds, addedBy: { id: member.id, name: member.name }, addedAt: Date.now() };
  }

  function makePendingItem(member: ServerMember, t: PendingTrack): QueueItem {
    const item: QueueItem = {
      ...makeQueueItem(member, { videoId: '', title: t.title, author: t.author, thumbnail: t.thumbnail, origin: t.origin, durationSec: t.durationSec }),
      status: 'resolving',
    };
    pendingTracks.set(item, t);
    return item;
  }

  /** Matches one pending playlist entry to YouTube, updating the item in place. */
  async function resolveItem(item: QueueItem): Promise<boolean> {
    const pending = pendingTracks.get(item);
    if (!pending) return item.status !== 'failed' && !!item.video.videoId;
    pendingTracks.delete(item);
    const meta = await resolvePending(pending);
    if (meta) {
      item.video = { ...meta, thumbnail: meta.thumbnail || thumbnailFor(meta.videoId) };
      delete item.status;
      return true;
    }
    item.status = 'failed';
    return false;
  }

  const resolving = new Set<string>();
  /** Background matching of imported playlists, two songs at a time, in queue order. */
  function resolveQueueInBackground(room: Room) {
    if (resolving.has(room.id)) return;
    resolving.add(room.id);
    const worker = async () => {
      for (;;) {
        const item = room.queue.find((q) => pendingTracks.has(q));
        if (!item || !store.get(room.id)) return;
        await resolveItem(item);
        if (room.queue.includes(item)) broadcastState(room);
      }
    };
    void Promise.all([worker(), worker()]).finally(() => resolving.delete(room.id));
  }

  /** Called by the upload endpoint: plays right away if the room is silent, otherwise queues. */
  function addUploadedTrack(room: Room, userId: UserId, meta: VideoMeta): 'playing' | 'queued' {
    const member = room.members.get(userId);
    if (!member) return 'queued';
    if (!room.video) {
      loadVideo(room, member, meta, 0);
      return 'playing';
    }
    if (room.queue.length < MAX_QUEUE_LENGTH) room.queue.push(makeQueueItem(member, meta));
    broadcastState(room);
    io.to(room.id).except(member.socketId ?? '').emit('room:notice', { kind: 'video', text: `${member.name} added “${meta.title}”` });
    return 'queued';
  }

  function removeMember(room: Room, userId: UserId) {
    const member = room.members.get(userId);
    if (!member || member.online) return;
    if (member.removalTimer) clearTimeout(member.removalTimer);
    room.members.delete(userId);
    io.to(room.id).emit('room:notice', { kind: 'left', text: `${member.name} left` });

    if (room.hostId === userId) {
      // Auto-promote the longest-present member so the party never ends up host-less.
      const next = nextHostCandidate(room) ?? room.members.values().next().value;
      room.hostId = next?.id ?? null;
      if (next) io.to(room.id).emit('room:notice', { kind: 'host', text: `${next.name} is now the host` });
    }
    broadcastState(room);
    store.scheduleDeletionIfEmpty(room);
  }

  /**
   * Movies start paused at 0:00 so everyone can open their copy (or connect to the stream)
   * before the host presses play. Readiness and subtitles reset with every new movie.
   */
  function loadMovie(room: Room, by: ServerMember, source: MovieSource) {
    room.video = {
      videoId: `${MOVIE_SOURCE_PREFIX}${randomUUID().slice(0, 12)}`,
      title: source.name,
      author: '',
      thumbnail: '',
      isLive: false,
      durationSec: 'duration' in source && source.duration > 0 ? Math.round(source.duration) : undefined,
      movie: source,
    };
    room.playback = { videoId: room.video.videoId, isPlaying: false, currentTime: 0, lastUpdatedAt: Date.now(), playbackRate: 1 };
    room.movieReady = new Map([[by.id, 'ready']]);
    room.subtitles = null;
    io.to(room.id).emit('movie:subtitles', null);
    // State first: clients need the movie's details (source, fingerprint) to act on the load.
    broadcastState(room);
    io.to(room.id).emit('player:sync', toSyncEvent(room, 'load', by.id));
    io.to(room.id).except(by.socketId ?? '').emit('room:notice', { kind: 'video', text: `${by.name} picked a movie: “${source.name}”` });
  }

  function loadVideo(room: Room, by: ServerMember, meta: NonNullable<Room['video']>, startSeconds: number) {
    room.video = meta;
    room.playback = {
      videoId: meta.videoId,
      isPlaying: true,
      currentTime: startSeconds,
      lastUpdatedAt: Date.now(),
      playbackRate: 1,
    };
    io.to(room.id).emit('player:sync', toSyncEvent(room, 'load', by.id));
    broadcastState(room);
    io.to(room.id).except(by.socketId ?? '').emit('room:notice', {
      kind: 'video',
      text: room.mode === 'music' ? `${by.name} is playing “${meta.title}”` : `${by.name} changed the video to “${meta.title}”`,
    });

    // Find out in the background whether this is a live stream (oEmbed doesn't say).
    // This also warms the suggestions cache for everyone's "Up next" list.
    if (meta.isLive === undefined) {
      void fetchWatchInfo(meta.videoId).then((info) => {
        if (!info || room.video?.videoId !== meta.videoId) return;
        room.video = { ...room.video, isLive: info.isLive };
        if (info.isLive) broadcastState(room);
      });
    }
  }

  io.on('connection', (socket: AppSocket) => {
    const limiter = new RateLimiter(SOCKET_LIMITS);

    /** Wraps a handler so a thrown error (or rejected promise) never crashes the process. */
    const on = (event: keyof ClientToServerEvents, handler: (...args: unknown[]) => unknown) => {
      socket.on(event, (...args: unknown[]) => {
        try {
          const result = handler(...args);
          if (result instanceof Promise) result.catch((err) => console.error(`[socket] ${event} failed`, err));
        } catch (err) {
          console.error(`[socket] ${event} failed`, err);
        }
      });
    };

    /** The room + member this socket currently represents, if any. */
    const current = () => {
      const { roomId, userId } = socket.data;
      if (!roomId || !userId) return null;
      const room = store.get(roomId);
      const member = room?.members.get(userId);
      if (!room || !member || member.socketId !== socket.id) return null;
      return { room, member };
    };

    const currentHost = () => {
      const c = current();
      return c && c.room.hostId === c.member.id ? c : null;
    };

    function detach(mode: 'leave' | 'disconnect') {
      const c = current();
      socket.data.roomId = undefined;
      if (!c) return;
      const { room, member } = c;
      socket.leave(room.id);
      member.socketId = null;
      member.online = false;
      if (mode === 'leave') {
        removeMember(room, member.id);
      } else {
        // Keep the seat warm so a page refresh / network blip doesn't trigger "left" + host changes.
        member.removalTimer = setTimeout(() => removeMember(room, member.id), MEMBER_GRACE_MS);
        broadcastState(room);
      }
    }

    on('time:ping', (ack) => {
      if (typeof ack === 'function' && limiter.take('ping')) ack(Date.now());
    });

    on('room:join', (raw, ack) => {
      if (!limiter.take('join')) return reply(ack, fail('Slow down a little and try again.', 'RATE_LIMITED'));
      const parsed = schemas.join.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Invalid room code or name.', 'INVALID'));
      const { roomId, userId, name } = parsed.data;

      const room = store.get(roomId);
      if (!room) return reply(ack, fail("This room doesn't exist or has expired.", 'ROOM_NOT_FOUND'));

      if (socket.data.roomId && socket.data.roomId !== room.id) detach('leave');

      let member = room.members.get(userId);
      const isNew = !member;
      if (member) {
        if (member.removalTimer) clearTimeout(member.removalTimer);
        member.removalTimer = null;
        if (member.socketId && member.socketId !== socket.id) {
          // Same identity connected from somewhere else (e.g. a duplicated tab): newest wins.
          const old = io.sockets.sockets.get(member.socketId);
          if (old) {
            old.data.roomId = undefined;
            old.leave(room.id);
            old.emit('room:closed', { reason: 'You opened this room in another tab.' });
          }
        }
        member.name = name;
        member.online = true;
        member.socketId = socket.id;
      } else {
        if (room.members.size >= MAX_MEMBERS) return reply(ack, fail('This room is full.'));
        member = { id: userId, name, color: colorFor(userId), joinedAt: Date.now(), online: true, socketId: socket.id, removalTimer: null };
        room.members.set(userId, member);
      }

      // The first person in (the creator) becomes host; also covers rooms whose host left.
      if (!room.hostId || !room.members.has(room.hostId)) room.hostId = userId;

      store.cancelDeletion(room);
      socket.join(room.id);
      socket.data.roomId = room.id;
      socket.data.userId = userId;

      reply(ack, ok({ selfId: userId, snapshot: toSnapshot(room), messages: room.messages }));
      socket.to(room.id).emit('room:state', toSnapshot(room));
      if (isNew) socket.to(room.id).emit('room:notice', { kind: 'joined', text: `${name} joined the party` });
      // Subtitles aren't part of the snapshot (they can be large), so late joiners get them separately.
      if (room.subtitles) socket.emit('movie:subtitles', room.subtitles);
    });

    on('room:leave', (ack) => {
      detach('leave');
      reply(ack, ok(null));
    });

    on('player:command', (raw, ack) => {
      const c = currentHost();
      if (!c) return reply(ack, fail('Only the host can control playback.', 'FORBIDDEN'));
      if (!limiter.take('control')) return reply(ack, fail('Too many actions, slow down.', 'RATE_LIMITED'));
      const parsed = schemas.command.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Invalid command.', 'INVALID'));
      const { room, member } = c;
      if (!room.playback.videoId) return reply(ack, fail('No video loaded yet.'));

      const { action, videoTime, sentAt } = parsed.data;
      const p = room.playback;
      p.currentTime = videoTime;
      p.lastUpdatedAt = stamp(sentAt, Date.now());
      if (action === 'play') p.isPlaying = true;
      if (action === 'pause') p.isPlaying = false;

      const ev = toSyncEvent(room, action as SyncAction, member.id);
      socket.to(room.id).emit('player:sync', ev);
      reply(ack, ok(ev));
    });

    on('player:heartbeat', (raw) => {
      const c = currentHost();
      if (!c || !c.room.playback.videoId || !limiter.take('heartbeat')) return;
      const parsed = schemas.heartbeat.safeParse(raw);
      if (!parsed.success) return;
      const p = c.room.playback;
      p.currentTime = parsed.data.videoTime;
      p.isPlaying = parsed.data.isPlaying;
      p.lastUpdatedAt = stamp(parsed.data.sentAt, Date.now());
      socket.to(c.room.id).emit('player:sync', toSyncEvent(c.room, 'heartbeat', c.member.id));
    });

    on('player:load', async (raw, ack) => {
      if (!currentHost()) return reply(ack, fail('Only the host can change the video.', 'FORBIDDEN'));
      if (!limiter.take('load')) return reply(ack, fail('Too many video changes, wait a moment.', 'RATE_LIMITED'));
      const parsed = schemas.url.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Invalid link.', 'INVALID'));
      const resolved = await resolveInput(currentHost()!.room, parsed.data.url);
      if (!resolved.ok) return reply(ack, fail(resolved.error, 'INVALID'));

      // Re-check after the await: host could have changed or left meanwhile.
      const c = currentHost();
      if (!c) return reply(ack, fail('Only the host can change the video.', 'FORBIDDEN'));
      if (resolved.tracks[0]) {
        loadVideo(c.room, c.member, resolved.tracks[0].meta, resolved.tracks[0].startSeconds);
        return reply(ack, ok(null));
      }
      // A playlist/album: play its first song now and line the rest up next.
      const items = resolved.pending.slice(0, MAX_QUEUE_LENGTH).map((t) => makePendingItem(c.member, t));
      const [first, ...rest] = items;
      if (!(await resolveItem(first))) return reply(ack, fail("Couldn't find the first song of that list on YouTube."));
      const now = currentHost();
      if (!now) return reply(ack, fail('Only the host can change the video.', 'FORBIDDEN'));
      now.room.queue = [...rest, ...now.room.queue].slice(0, MAX_QUEUE_LENGTH);
      loadVideo(now.room, now.member, first.video, 0);
      resolveQueueInBackground(now.room);
      reply(ack, ok(null));
    });

    on('queue:add', async (raw, ack) => {
      if (!current()) return reply(ack, fail('Join the room first.'));
      if (!limiter.take('queue')) return reply(ack, fail('Too many suggestions, wait a moment.', 'RATE_LIMITED'));
      const parsed = schemas.url.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Invalid link.', 'INVALID'));
      const resolved = await resolveInput(current()!.room, parsed.data.url);
      if (!resolved.ok) return reply(ack, fail(resolved.error, 'INVALID'));

      const c = current();
      if (!c) return reply(ack, fail('Join the room first.'));
      const room = c.room;
      const space = MAX_QUEUE_LENGTH - room.queue.length;
      if (space <= 0) return reply(ack, fail('The queue is full.'));
      const items = [
        ...resolved.tracks.map((t) => makeQueueItem(c.member, t.meta, t.startSeconds)),
        ...resolved.pending.map((t) => makePendingItem(c.member, t)),
      ].slice(0, space);
      room.queue.push(...items);
      broadcastState(room);
      if (resolved.pending.length) {
        resolveQueueInBackground(room);
        socket.to(room.id).emit('room:notice', {
          kind: 'video',
          text: `${c.member.name} added ${items.length} songs from “${resolved.listName ?? 'a playlist'}”`,
        });
      }
      reply(ack, ok(null));
    });

    on('queue:remove', (raw, ack) => {
      const c = current();
      const parsed = schemas.item.safeParse(raw);
      if (!c || !parsed.success) return reply(ack, fail('Invalid request.', 'INVALID'));
      const item = c.room.queue.find((q) => q.id === parsed.data.itemId);
      if (!item) return reply(ack, fail('That video is no longer in the queue.'));
      if (c.room.hostId !== c.member.id && item.addedBy.id !== c.member.id) {
        return reply(ack, fail('Only the host or the person who added it can remove it.', 'FORBIDDEN'));
      }
      c.room.queue = c.room.queue.filter((q) => q.id !== item.id);
      broadcastState(c.room);
      reply(ack, ok(null));
    });

    const playFromQueue = async (ack: unknown, pick: (room: Room) => QueueItem | undefined) => {
      const c = currentHost();
      if (!c) return reply(ack, fail('Only the host can play from the queue.', 'FORBIDDEN'));
      if (!limiter.take('load')) return reply(ack, fail('Too many video changes, wait a moment.', 'RATE_LIMITED'));
      const item = pick(c.room);
      if (!item) return reply(ack, fail('Nothing to play.'));
      // A playlist entry that hasn't been matched yet is matched right now.
      if (!(await resolveItem(item))) {
        broadcastState(c.room);
        return reply(ack, fail(`Couldn't find “${item.video.title}” on YouTube.`));
      }
      const now = currentHost();
      if (!now) return reply(ack, fail('Only the host can play from the queue.', 'FORBIDDEN'));
      now.room.queue = now.room.queue.filter((q) => q !== item);
      loadVideo(now.room, now.member, item.video, item.startSeconds);
      reply(ack, ok(null));
    };

    on('queue:play', (raw, ack) => {
      const parsed = schemas.item.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Invalid request.', 'INVALID'));
      return playFromQueue(ack, (room) => room.queue.find((q) => q.id === parsed.data.itemId));
    });

    on('queue:next', (ack) => playFromQueue(ack, (room) => room.queue.find((q) => q.status !== 'failed')));

    on('movie:load', (raw, ack) => {
      const c = currentHost();
      if (!c || c.room.mode !== 'movies') return reply(ack, fail('Only the host can pick the movie.', 'FORBIDDEN'));
      if (!limiter.take('load')) return reply(ack, fail('Too many changes, wait a moment.', 'RATE_LIMITED'));
      const parsed = schemas.movieLoad.safeParse(raw);
      if (!parsed.success) return reply(ack, fail(parsed.error.issues[0]?.message ?? 'Invalid movie.', 'INVALID'));
      loadMovie(c.room, c.member, parsed.data.source as MovieSource);
      reply(ack, ok(null));
    });

    on('movie:ready', (raw) => {
      const c = current();
      const parsed = schemas.movieReady.safeParse(raw);
      if (!c || !parsed.success || !limiter.take('ready')) return;
      if (c.room.video?.videoId !== parsed.data.videoId) return; // a report about an old movie
      if (c.room.movieReady.get(c.member.id) === parsed.data.state) return;
      c.room.movieReady.set(c.member.id, parsed.data.state);
      broadcastState(c.room);
    });

    on('movie:subtitles', (raw, ack) => {
      const c = currentHost();
      if (!c || c.room.mode !== 'movies') return reply(ack, fail('Only the host can share subtitles.', 'FORBIDDEN'));
      if (!limiter.take('subtitles')) return reply(ack, fail('Too many subtitle changes.', 'RATE_LIMITED'));
      const parsed = schemas.subtitles.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('That subtitle file is too large or invalid.', 'INVALID'));
      c.room.subtitles = parsed.data.track;
      io.to(c.room.id).emit('movie:subtitles', c.room.subtitles);
      if (c.room.subtitles) {
        socket.to(c.room.id).emit('room:notice', { kind: 'info', text: `${c.member.name} shared subtitles: ${c.room.subtitles.name}` });
      }
      reply(ack, ok(null));
    });

    /**
     * WebRTC signalling for "stream from my device": a plain relay between the host and one viewer.
     * Media never touches the server; it flows peer-to-peer.
     */
    on('rtc:signal', (raw) => {
      const c = current();
      const parsed = schemas.rtcSignal.safeParse(raw);
      if (!c || !parsed.success || !limiter.take('rtc')) return;
      const target = c.room.members.get(parsed.data.to);
      const involvesHost = c.room.hostId === c.member.id || c.room.hostId === parsed.data.to;
      if (!target?.socketId || !involvesHost || target.id === c.member.id) return;
      io.to(target.socketId).emit('rtc:signal', { from: c.member.id, signal: parsed.data.signal });
    });

    on('room:mood', (raw, ack) => {
      const c = currentHost();
      if (!c) return reply(ack, fail('Only the host can set the mood.', 'FORBIDDEN'));
      if (!limiter.take('mood')) return reply(ack, fail('Give the mood a moment to settle.', 'RATE_LIMITED'));
      const parsed = schemas.mood.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Unknown mood.', 'INVALID'));
      c.room.mood = parsed.data.mood;
      broadcastState(c.room);
      reply(ack, ok(null));
    });

    on('music:uploadToken', (ack) => {
      const c = current();
      if (!c || c.room.mode !== 'music') return reply(ack, fail('Uploads are only available in music rooms.'));
      if (!limiter.take('uploadToken')) return reply(ack, fail('Too many requests.', 'RATE_LIMITED'));
      reply(ack, ok(uploads.issueToken(c.room.id, c.member.id)));
    });

    on('host:transfer', (raw, ack) => {
      const c = currentHost();
      if (!c) return reply(ack, fail('Only the host can hand over control.', 'FORBIDDEN'));
      const parsed = schemas.transfer.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Invalid request.', 'INVALID'));
      const target = c.room.members.get(parsed.data.userId);
      if (!target || !target.online || target.id === c.member.id) return reply(ack, fail('That person is not available.'));
      c.room.hostId = target.id;
      broadcastState(c.room);
      io.to(c.room.id).emit('room:notice', { kind: 'host', text: `${c.member.name} made ${target.name} the host` });
      reply(ack, ok(null));
    });

    on('room:autoplay', (raw, ack) => {
      const c = currentHost();
      if (!c) return reply(ack, fail('Only the host can change autoplay.', 'FORBIDDEN'));
      const parsed = schemas.autoplay.safeParse(raw);
      if (!parsed.success) return reply(ack, fail('Invalid request.', 'INVALID'));
      c.room.autoplay = parsed.data.enabled;
      broadcastState(c.room);
      reply(ack, ok(null));
    });

    on('chat:send', (raw, ack) => {
      const c = current();
      if (!c) return reply(ack, fail('Join the room first.'));
      if (!limiter.take('chat')) return reply(ack, fail("You're sending messages too fast.", 'RATE_LIMITED'));
      const parsed = schemas.chat.safeParse(raw);
      if (!parsed.success) return reply(ack, fail(parsed.error.issues[0]?.message ?? 'Invalid message.', 'INVALID'));
      const msg = {
        id: randomUUID(),
        userId: c.member.id,
        name: c.member.name,
        color: c.member.color,
        text: parsed.data.text,
        sentAt: Date.now(),
      };
      c.room.messages.push(msg);
      if (c.room.messages.length > CHAT_HISTORY_LIMIT) c.room.messages.splice(0, c.room.messages.length - CHAT_HISTORY_LIMIT);
      io.to(c.room.id).emit('chat:message', msg);
      reply(ack, ok(null));
    });

    on('reaction:send', (raw) => {
      const c = current();
      const parsed = schemas.reaction.safeParse(raw);
      if (!c || !parsed.success || !limiter.take('reaction')) return;
      io.to(c.room.id).emit('reaction', { id: randomUUID(), emoji: parsed.data.emoji, userId: c.member.id, name: c.member.name });
    });

    socket.on('disconnect', () => detach('disconnect'));
  });

  return { addUploadedTrack };
}
