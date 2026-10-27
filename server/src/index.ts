import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { SUBTITLE_MAX_CHARS, UPLOAD_MAX_BYTES, normalizeRoomCode } from '@shared/constants';
import type {
  ClientToServerEvents,
  MusicSearchResponse,
  ServerToClientEvents,
  SocketData,
  SuggestionsResponse,
  UploadResponse,
} from '@shared/types';
import { CLIENT_URLS, IS_PROD, PORT, isAllowedOrigin } from './config';
import { fetchVideoMeta } from './oembed';
import { IpRateLimiter } from './rateLimiter';
import { RoomStore, positionAt } from './roomStore';
import { registerSocketHandlers } from './socketHandlers';
import { UploadStore } from './uploads';
import { schemas } from './validation';
import { searchYouTube } from './youtubeSearch';
import { fetchWatchInfo } from './youtubeWatch';

const corsOptions: cors.CorsOptions = {
  origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
  methods: ['GET', 'POST'],
};

const uploads = new UploadStore();
const store = new RoomStore((roomId) => uploads.deleteRoom(roomId));
const createLimiter = new IpRateLimiter({ capacity: 10, refillPerSec: 10 / 60 });
const suggestLimiter = new IpRateLimiter({ capacity: 20, refillPerSec: 30 / 60 });
const searchLimiter = new IpRateLimiter({ capacity: 30, refillPerSec: 40 / 60 });
const uploadLimiter = new IpRateLimiter({ capacity: 15, refillPerSec: 15 / 600 });
const subtitleLimiter = new IpRateLimiter({ capacity: 5, refillPerSec: 5 / 600 });
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.set('trust proxy', 1);
app.use(cors(corsOptions));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: store.size, uptime: Math.round(process.uptime()) });
});

app.post('/api/rooms', (req, res) => {
  if (!createLimiter.take(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Too many rooms created. Try again in a minute.' });
    return;
  }
  const parsed = schemas.createRoom.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Unknown room type.' });
    return;
  }
  const room = store.create(parsed.data.mode);
  res.status(201).json({ roomId: room.id, mode: room.mode });
});

app.get('/api/rooms/:id', (req, res) => {
  const code = normalizeRoomCode(req.params.id);
  const room = code ? store.get(code) : undefined;
  if (!room) {
    res.status(404).json({ error: "This room doesn't exist or has expired." });
    return;
  }
  res.json({
    roomId: room.id,
    memberCount: [...room.members.values()].filter((m) => m.online).length,
    video: room.video,
    position: positionAt(room.playback),
  });
});

/** YouTube's "up next" recommendations for a video, plus whether it's live. */
app.get('/api/videos/:id/suggestions', async (req, res) => {
  const { id } = req.params;
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) {
    res.status(400).json({ error: 'Invalid video id.' });
    return;
  }
  if (!suggestLimiter.take(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Too many requests. Try again in a moment.' });
    return;
  }
  const info = await fetchWatchInfo(id);
  let suggestions = info?.suggestions ?? [];
  if (!suggestions.length) {
    // Cloud servers sometimes get YouTube's watch page refused while search still works, so fall
    // back to "more like this" from a search on the video's title and channel.
    const meta = await fetchVideoMeta(id);
    if (meta.ok) {
      const query = `${meta.meta.author} ${meta.meta.title}`.replace(/\(.*?\)|\[.*?\]|official|video|audio|lyrics?/gi, ' ').trim();
      suggestions = (await searchYouTube(query)).filter((s) => s.videoId !== id && !s.isLive);
    }
  }
  if (!suggestions.length) {
    res.status(502).json({ error: "Couldn't reach YouTube for suggestions." });
    return;
  }
  res.set('Cache-Control', 'public, max-age=120');
  const body: SuggestionsResponse = { videoId: id, isLive: info?.isLive ?? false, suggestions };
  res.json(body);
});

/** Song search for music rooms (YouTube results, best matches first). */
app.get('/api/music/search', async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  if (q.length < 2) {
    res.status(400).json({ error: 'Type at least two characters.' });
    return;
  }
  if (!searchLimiter.take(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Searching too fast. Try again in a moment.' });
    return;
  }
  const results = (await searchYouTube(q)).filter((r) => !r.isLive).slice(0, 10);
  res.set('Cache-Control', 'public, max-age=300');
  const body: MusicSearchResponse = { query: q, results };
  res.json(body);
});

/**
 * Upload a song from your device. The body is the raw file; the per-member token comes from the
 * socket ('room:uploadToken'), so only people in the room can add files to it.
 */
app.post(
  '/api/rooms/:id/uploads',
  express.raw({ type: () => true, limit: UPLOAD_MAX_BYTES + 1024 }),
  async (req, res) => {
    const roomId = normalizeRoomCode(req.params.id);
    const room = roomId ? store.get(roomId) : undefined;
    if (!room || room.mode !== 'music') {
      res.status(404).json({ error: 'Music room not found.' });
      return;
    }
    const auth = uploads.checkToken(req.get('X-Upload-Token'), room.id);
    if (!auth || !room.members.get(auth.userId)?.online) {
      res.status(403).json({ error: 'Your upload session expired. Rejoin the room and try again.' });
      return;
    }
    if (!uploadLimiter.take(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'Too many uploads. Try again in a few minutes.' });
      return;
    }
    let fileName = 'Untitled';
    try {
      fileName = decodeURIComponent(req.get('X-File-Name') ?? 'Untitled').slice(0, 200);
    } catch {
      /* keep default */
    }
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const saved = await uploads.save(room.id, body, fileName, req.get('Content-Type'));
    if (!saved.ok) {
      res.status(saved.status).json({ error: saved.error });
      return;
    }
    const placement = registered.addUploadedTrack(room, auth.userId, saved.track.meta);
    const response: UploadResponse = { track: saved.track.meta, placement };
    res.status(201).json(response);
  },
);

/** Streams an uploaded song (with Range support so seeking is instant) or its cover art. */
app.get(['/media/:roomId/:fileId', '/media/:roomId/:fileId/cover'], (req, res) => {
  const roomId = normalizeRoomCode(req.params.roomId);
  const { fileId } = req.params;
  const track = roomId && FILE_ID_RE.test(fileId) ? uploads.get(roomId, fileId) : undefined;
  const wantsCover = req.path.endsWith('/cover');
  const file = wantsCover ? track?.cover : track ? { path: track.filePath, mime: track.mime } : undefined;
  if (!file) {
    res.status(404).end();
    return;
  }
  // Served bytes are always the validated audio/image; never let a browser treat them as a page.
  res.set({
    'Content-Type': file.mime,
    'Cache-Control': 'private, max-age=86400, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.sendFile(file.path, { acceptRanges: true, lastModified: false, dotfiles: 'allow' });
});

/**
 * Shared subtitles for movie rooms. They go over HTTP rather than the socket because hosting
 * proxies (Render's included) drop WebSocket messages above a few hundred KB, and SRT files for
 * long films can be that big. The socket only announces { name, version }.
 */
app.post(
  '/api/rooms/:id/subtitles',
  express.text({ type: () => true, limit: SUBTITLE_MAX_CHARS * 4 }),
  (req, res) => {
    const roomId = normalizeRoomCode(req.params.id);
    const room = roomId ? store.get(roomId) : undefined;
    if (!room || room.mode !== 'movies') {
      res.status(404).json({ error: 'Movie room not found.' });
      return;
    }
    const auth = uploads.checkToken(req.get('X-Upload-Token'), room.id);
    const member = auth ? room.members.get(auth.userId) : undefined;
    if (!member?.online || room.hostId !== member.id) {
      res.status(403).json({ error: 'Only the host can share subtitles.' });
      return;
    }
    if (!subtitleLimiter.take(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'Too many subtitle changes. Try again in a minute.' });
      return;
    }
    let name = 'Subtitles';
    try {
      name = decodeURIComponent(req.get('X-File-Name') ?? name);
    } catch {
      /* keep default */
    }
    const parsed = schemas.subtitles.safeParse({ name, text: typeof req.body === 'string' ? req.body : '' });
    if (!parsed.success) {
      res.status(413).json({ error: 'That subtitle file is too large or empty.' });
      return;
    }
    registered.setSubtitles(room, member, parsed.data);
    res.status(201).json({ ok: true });
  },
);

app.get('/api/rooms/:id/subtitles', (req, res) => {
  const roomId = normalizeRoomCode(req.params.id);
  const subs = roomId ? store.get(roomId)?.subtitles : undefined;
  if (!subs) {
    res.status(404).end();
    return;
  }
  // The version is in the query string, so each version can be cached forever.
  res.set({ 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.send(subs.text);
});

// Body-size and parse errors from express.raw/json come back as tidy JSON.
app.use((err: { status?: number; type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: 'Files can be up to 50 MB.' });
    return;
  }
  if (err?.status && err.status < 500) {
    res.status(err.status).json({ error: 'Bad request.' });
    return;
  }
  next(err);
});

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
  cors: corsOptions,
  // CORS headers don't apply to WebSocket upgrades, so check the origin on every handshake too.
  allowRequest: (req, cb) => cb(null, isAllowedOrigin(req.headers.origin)),
  pingInterval: 10_000,
  pingTimeout: 8_000,
  // Socket messages stay small (big payloads such as files and subtitles go over HTTP);
  // hosting proxies also drop large WebSocket frames.
  maxHttpBufferSize: 64 * 1024,
});

const registered = registerSocketHandlers(io, store, uploads);

httpServer.listen(PORT, () => {
  console.log(`[relax-together] server listening on :${PORT} (${IS_PROD ? 'production' : 'development'})`);
  if (IS_PROD) console.log(`[relax-together] allowed origins: ${CLIENT_URLS.join(', ')}`);
});

const shutdown = () => {
  io.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
