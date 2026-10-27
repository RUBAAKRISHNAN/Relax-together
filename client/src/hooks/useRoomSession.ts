import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { MoodId, ReactionEmoji } from '@shared/constants';
import type {
  ChatMessage,
  JoinResult,
  MovieReadyState,
  MovieSource,
  ReactionEvent,
  RoomSnapshot,
  SubtitleInfo,
  SubtitleTrack,
} from '@shared/types';
import { useToast } from '../components/Toasts';
import { ServerClock } from '../lib/clock';
import { getUserId } from '../lib/identity';
import { SERVER_URL } from '../lib/env';
import { createSocket, request } from '../lib/socket';
import { SyncEngine } from '../lib/syncEngine';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

export interface FloatingReaction extends ReactionEvent {
  /** Horizontal position in % of the video width. */
  x: number;
}

const MAX_MESSAGES = 200;

/**
 * Owns the socket, server clock and sync engine for one room visit. Joins on connect and
 * re-joins on every reconnect (same per-tab user id), so a dropped connection resumes
 * seamlessly, including host status.
 */
export function useRoomSession(roomId: string, name: string, onFatal: (error: string) => void) {
  const [session] = useState(() => {
    const socket = createSocket();
    const clock = new ServerClock(socket);
    const selfId = getUserId();
    return { socket, clock, selfId, engine: new SyncEngine(socket, clock, selfId) };
  });
  const toast = useToast();

  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [subtitles, setSubtitles] = useState<SubtitleTrack | null>(null);
  const [subtitleInfo, setSubtitleInfo] = useState<SubtitleInfo | null>(null);

  useEffect(() => {
    const { socket, clock, engine, selfId } = session;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const applySnapshot = (s: RoomSnapshot) => {
      engine.setHost(s.hostId === selfId);
      setSnapshot(s);
    };

    const join = async () => {
      // Measure the clock offset before applying any timestamps from the server.
      await clock.sync();
      if (closed || !socket.connected) return;
      const res = await request<JoinResult>(socket, 'room:join', { roomId, userId: selfId, name });
      if (closed) return;
      if (res.ok) {
        applySnapshot(res.data.snapshot);
        setMessages(res.data.messages);
        engine.applySnapshot(res.data.snapshot);
      } else if (res.code === 'ROOM_NOT_FOUND' || res.code === 'INVALID') {
        onFatal(res.error);
      } else {
        toast(res.error, 'error');
        retryTimer = setTimeout(() => void join(), 2000);
      }
    };

    const onConnect = () => {
      setConnection('connected');
      engine.setConnected(true);
      void join();
    };
    const onDisconnect = (reason: string) => {
      if (closed) return;
      setConnection('reconnecting');
      engine.setConnected(false);
      // A server-initiated disconnect isn't retried automatically by Socket.IO.
      if (reason === 'io server disconnect') socket.connect();
    };
    const onConnectError = () => {
      setConnection((c) => (c === 'connected' ? 'reconnecting' : c));
      engine.setConnected(false);
    };
    const onMessage = (msg: ChatMessage) => setMessages((prev) => [...prev.slice(-(MAX_MESSAGES - 1)), msg]);
    const onReaction = (ev: ReactionEvent) => {
      const item: FloatingReaction = { ...ev, x: 8 + Math.random() * 80 };
      setReactions((prev) => [...prev.slice(-24), item]);
      setTimeout(() => setReactions((prev) => prev.filter((r) => r.id !== ev.id)), 2800);
    };
    const onNotice = ({ kind, text }: { kind: string; text: string }) =>
      toast(text, kind === 'left' ? 'leave' : kind === 'joined' ? 'join' : kind === 'host' ? 'host' : 'video');
    const onClosed = ({ reason }: { reason: string }) => {
      closed = true;
      socket.disconnect();
      onFatal(reason);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('room:state', applySnapshot);
    socket.on('chat:message', onMessage);
    socket.on('reaction', onReaction);
    socket.on('room:notice', onNotice);
    socket.on('room:closed', onClosed);
    socket.on('movie:subtitles', setSubtitleInfo);
    engine.start();
    clock.start();
    socket.connect();
    if (import.meta.env.DEV) (window as unknown as { __watchparty: unknown }).__watchparty = engine;

    return () => {
      closed = true;
      clearTimeout(retryTimer);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('room:state', applySnapshot);
      socket.off('chat:message', onMessage);
      socket.off('reaction', onReaction);
      socket.off('room:notice', onNotice);
      socket.off('room:closed', onClosed);
      socket.off('movie:subtitles', setSubtitleInfo);
      engine.stop();
      clock.stop();
      socket.disconnect();
    };
    // onFatal/toast are stable for the lifetime of a room visit, so they're left out of the deps.
  }, [session, roomId, name]);

  // Shared subtitles: the socket announces a version, the text is fetched over HTTP.
  useEffect(() => {
    if (!subtitleInfo) {
      setSubtitles(null);
      return;
    }
    const controller = new AbortController();
    fetch(`${SERVER_URL}/api/rooms/${roomId}/subtitles?v=${subtitleInfo.version}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => setSubtitles({ name: subtitleInfo.name, text }))
      .catch((err: Error) => err.name !== 'AbortError' && toast("Couldn't load the shared subtitles.", 'error'));
    return () => controller.abort();
    // toast is stable for the lifetime of a room visit.
  }, [subtitleInfo, roomId]);

  const actions = useMemo(() => {
    const { socket } = session;
    const errorOf = (res: { ok: boolean; error?: string }) => (res.ok ? null : res.error ?? 'Something went wrong.');
    return {
      loadVideo: async (url: string) => errorOf(await request(socket, 'player:load', { url })),
      queueAdd: async (url: string) => errorOf(await request(socket, 'queue:add', { url })),
      queueRemove: async (itemId: string) => errorOf(await request(socket, 'queue:remove', { itemId })),
      queuePlay: async (itemId: string) => errorOf(await request(socket, 'queue:play', { itemId })),
      queueNext: async () => errorOf(await request(socket, 'queue:next')),
      transferHost: async (userId: string) => errorOf(await request(socket, 'host:transfer', { userId })),
      setAutoplay: async (enabled: boolean) => errorOf(await request(socket, 'room:autoplay', { enabled })),
      setMood: async (mood: MoodId) => errorOf(await request(socket, 'room:mood', { mood })),
      loadMovie: async (source: MovieSource) => errorOf(await request(socket, 'movie:load', { source })),
      reportMovieReady: (videoId: string, state: MovieReadyState) => socket.emit('movie:ready', { videoId, state }),
      shareSubtitles: async (track: SubtitleTrack | null): Promise<string | null> => {
        if (!track) return errorOf(await request(socket, 'movie:clearSubtitles'));
        const auth = await request<{ token: string }>(socket, 'room:uploadToken');
        if (!auth.ok) return auth.error;
        try {
          const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/subtitles`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Upload-Token': auth.data.token, 'X-File-Name': encodeURIComponent(track.name) },
            body: track.text,
          });
          if (res.ok) return null;
          return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not share the subtitles.';
        } catch {
          return "Couldn't reach the server.";
        }
      },
      getUploadToken: async (): Promise<{ token: string } | { error: string }> => {
        const res = await request<{ token: string; expiresAt: number }>(socket, 'room:uploadToken');
        return res.ok ? { token: res.data.token } : { error: res.error };
      },
      sendChat: async (text: string) => errorOf(await request(socket, 'chat:send', { text })),
      sendReaction: (emoji: ReactionEmoji) => socket.emit('reaction:send', { emoji }),
      leave: () => {
        if (socket.connected) socket.emit('room:leave');
      },
    };
  }, [session, roomId]);

  return {
    selfId: session.selfId,
    engine: session.engine,
    socket: session.socket,
    subtitles,
    connection,
    snapshot,
    messages,
    reactions,
    actions,
  };
}

export type RoomActions = ReturnType<typeof useRoomSession>['actions'];

export function useEngineState(engine: SyncEngine) {
  return useSyncExternalStore(engine.subscribe, engine.getState);
}
