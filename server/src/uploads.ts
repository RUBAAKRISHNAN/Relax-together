import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseBuffer } from 'music-metadata';
import {
  FILE_SOURCE_PREFIX,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_BYTES_PER_ROOM,
  UPLOAD_MAX_FILES_PER_ROOM,
} from '@shared/constants';
import type { UserId, VideoMeta } from '@shared/types';
import { sanitizeText } from './validation';

/**
 * Music people upload from their own devices. Files live on local disk next to the room (in the
 * OS temp dir), are only reachable through unguessable ids, and are deleted with the room.
 */

export interface UploadedTrack {
  id: string;
  roomId: string;
  filePath: string;
  mime: string;
  size: number;
  cover: { path: string; mime: string } | null;
  meta: VideoMeta;
}

type SaveResult = { ok: true; track: UploadedTrack } | { ok: false; status: number; error: string };

const TOKEN_TTL_MS = 30 * 60 * 1000;
const GLOBAL_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const COVER_TYPES: Record<string, string> = { 'image/jpeg': 'image/jpeg', 'image/jpg': 'image/jpeg', 'image/png': 'image/png', 'image/webp': 'image/webp' };

/** Maps the container music-metadata detected to the Content-Type we serve. */
function mimeFor(container: string): string | null {
  const c = container.toLowerCase();
  if (c.includes('mpeg')) return 'audio/mpeg';
  if (c.includes('flac')) return 'audio/flac';
  if (c.includes('wave') || c.includes('wav')) return 'audio/wav';
  if (c.includes('ogg')) return 'audio/ogg';
  if (c.includes('webm') || c.includes('matroska') || c.includes('ebml')) return 'audio/webm';
  if (c.includes('adts') || c === 'aac') return 'audio/aac';
  if (c.includes('m4a') || c.includes('mp4') || c.includes('isom') || c.includes('mp42') || c.includes('3gp')) return 'audio/mp4';
  if (c.includes('aiff')) return 'audio/aiff';
  return null;
}

export class UploadStore {
  private rooms = new Map<string, Map<string, UploadedTrack>>();
  private tokens = new Map<string, { roomId: string; userId: UserId; expires: number }>();
  private totalBytes = 0;

  constructor(private baseDir = path.join(tmpdir(), 'relax-together-uploads')) {
    // Uploads never outlive the process (rooms are in memory), so start from a clean slate.
    rmSync(this.baseDir, { recursive: true, force: true });
    mkdirSync(this.baseDir, { recursive: true });
    setInterval(() => {
      const now = Date.now();
      for (const [t, v] of this.tokens) if (v.expires < now) this.tokens.delete(t);
    }, 60_000).unref();
  }

  /** Short-lived upload permission handed to a room member over their socket. */
  issueToken(roomId: string, userId: UserId) {
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.tokens.set(token, { roomId, userId, expires: expiresAt });
    return { token, expiresAt };
  }

  checkToken(token: string | undefined, roomId: string): { userId: UserId } | null {
    const entry = token ? this.tokens.get(token) : undefined;
    if (!entry || entry.roomId !== roomId || entry.expires < Date.now()) return null;
    return { userId: entry.userId };
  }

  get(roomId: string, fileId: string): UploadedTrack | undefined {
    return this.rooms.get(roomId)?.get(fileId);
  }

  getBySource(roomId: string, source: string): UploadedTrack | undefined {
    return source.startsWith(FILE_SOURCE_PREFIX) ? this.get(roomId, source.slice(FILE_SOURCE_PREFIX.length)) : undefined;
  }

  async save(roomId: string, body: Buffer, fileName: string, contentType: string | undefined): Promise<SaveResult> {
    if (!body.length) return { ok: false, status: 400, error: 'The file is empty.' };
    if (body.length > UPLOAD_MAX_BYTES) return { ok: false, status: 413, error: 'Files can be up to 50 MB.' };

    const room = this.rooms.get(roomId) ?? new Map<string, UploadedTrack>();
    const roomBytes = [...room.values()].reduce((n, t) => n + t.size, 0);
    if (room.size >= UPLOAD_MAX_FILES_PER_ROOM) return { ok: false, status: 409, error: 'This room has reached its upload limit.' };
    if (roomBytes + body.length > UPLOAD_MAX_BYTES_PER_ROOM || this.totalBytes + body.length > GLOBAL_MAX_BYTES) {
      return { ok: false, status: 507, error: 'Upload storage is full for this room.' };
    }

    // Parsing doubles as validation: anything that isn't real audio is rejected here.
    let parsed;
    try {
      parsed = await parseBuffer(new Uint8Array(body), { mimeType: contentType, size: body.length }, { duration: true });
    } catch {
      return { ok: false, status: 415, error: "That doesn't look like an audio file." };
    }
    const mime = mimeFor(parsed.format.container ?? '');
    const duration = parsed.format.duration ?? 0;
    if (!mime || !(duration > 0)) return { ok: false, status: 415, error: "That doesn't look like a playable audio file." };

    const id = randomUUID();
    const dir = path.join(this.baseDir, roomId);
    mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, id);
    await writeFile(filePath, body);

    let cover: UploadedTrack['cover'] = null;
    const picture = parsed.common.picture?.[0];
    const coverMime = picture ? COVER_TYPES[picture.format.toLowerCase()] : undefined;
    if (picture && coverMime && picture.data.length < 5 * 1024 * 1024) {
      cover = { path: `${filePath}.cover`, mime: coverMime };
      await writeFile(cover.path, picture.data);
    }

    const baseName = fileName.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[_]+/g, ' ');
    const title = sanitizeText(parsed.common.title ?? '') || sanitizeText(baseName) || 'Untitled track';
    const meta: VideoMeta = {
      videoId: `${FILE_SOURCE_PREFIX}${id}`,
      title: title.slice(0, 200),
      author: sanitizeText(parsed.common.artist ?? parsed.common.albumartist ?? '').slice(0, 100),
      album: sanitizeText(parsed.common.album ?? '').slice(0, 100) || undefined,
      thumbnail: cover ? `/media/${roomId}/${id}/cover` : '',
      durationSec: Math.round(duration),
      origin: 'upload',
      isLive: false,
    };

    const track: UploadedTrack = { id, roomId, filePath, mime, size: body.length, cover, meta };
    room.set(id, track);
    this.rooms.set(roomId, room);
    this.totalBytes += body.length;
    return { ok: true, track };
  }

  deleteRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (room) for (const t of room.values()) this.totalBytes -= t.size;
    this.rooms.delete(roomId);
    for (const [t, v] of this.tokens) if (v.roomId === roomId) this.tokens.delete(t);
    rmSync(path.join(this.baseDir, roomId), { recursive: true, force: true });
  }
}
