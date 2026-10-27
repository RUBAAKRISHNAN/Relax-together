import { z } from 'zod';
import {
  MAX_CHAT_LENGTH,
  MAX_NAME_LENGTH,
  MAX_VIDEO_TIME,
  MOOD_IDS,
  MOVIE_SOURCE_PREFIX,
  REACTION_EMOJIS,
  SUBTITLE_MAX_CHARS,
  normalizeRoomCode,
} from '@shared/constants';

/** Strips control characters and bidi overrides (which can be used to spoof text) and trims. */
export function sanitizeText(input: string): string {
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B\u202A-\u202E\u2066-\u2069]/g, ' ')
    .replace(/\s{3,}/g, '  ')
    .trim();
}

const codePointLength = (s: string) => Array.from(s).length;

const roomId = z
  .string()
  .max(200)
  .transform((s, ctx) => {
    const code = normalizeRoomCode(s);
    if (!code) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid room code' });
    return code ?? '';
  });

const userId = z.string().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

const displayName = z
  .string()
  .max(200)
  .transform(sanitizeText)
  .refine((s) => codePointLength(s) >= 1 && codePointLength(s) <= MAX_NAME_LENGTH, 'Invalid name');

const videoTime = z.number().finite().min(0).max(MAX_VIDEO_TIME);

const movieTitle = z
  .string()
  .max(300)
  .transform(sanitizeText)
  .refine((s) => s.length > 0, 'Missing title')
  .transform((s) => s.slice(0, 200));

/** Only plain http(s) links; everyone's browser loads them directly (the server never fetches them). */
const mediaUrl = z
  .string()
  .max(2048)
  .refine((s) => {
    try {
      return ['http:', 'https:'].includes(new URL(s).protocol);
    } catch {
      return false;
    }
  }, 'Use an http(s) link');

const movieSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    name: movieTitle,
    size: z.number().int().min(1).max(500 * 1024 ** 3),
    fingerprint: z.string().regex(/^[a-z0-9:]{8,128}$/),
    duration: z.number().finite().min(0).max(MAX_VIDEO_TIME),
  }),
  z.object({ kind: z.literal('url'), name: movieTitle, url: mediaUrl }),
  z.object({
    kind: z.literal('stream'),
    name: movieTitle,
    size: z.number().int().min(1).max(500 * 1024 ** 3),
    fingerprint: z.string().regex(/^[a-z0-9:]{8,128}$/),
    duration: z.number().finite().min(0).max(MAX_VIDEO_TIME),
  }),
]);

const rtcSignal = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().max(20_000), sid: z.string().max(32) }),
  z.object({
    type: z.literal('candidate'),
    sid: z.string().max(32),
    candidate: z.object({
      candidate: z.string().max(1000).optional(),
      sdpMid: z.string().max(64).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }),
  }),
  z.object({ type: z.literal('hello') }),
  z.object({ type: z.literal('bye') }),
]);
const timestamp = z.number().finite();

export const schemas = {
  join: z.object({ roomId, userId, name: displayName }),
  command: z.object({ action: z.enum(['play', 'pause', 'seek']), videoTime, sentAt: timestamp }),
  heartbeat: z.object({ videoTime, isPlaying: z.boolean(), sentAt: timestamp }),
  url: z.object({ url: z.string().min(1).max(2048) }),
  item: z.object({ itemId: z.string().min(1).max(64) }),
  transfer: z.object({ userId }),
  autoplay: z.object({ enabled: z.boolean() }),
  mood: z.object({ mood: z.enum(MOOD_IDS) }),
  createRoom: z.object({ mode: z.enum(['youtube', 'music', 'movies']).default('youtube') }).default({}),
  movieLoad: z.object({ source: movieSource }),
  movieReady: z.object({
    videoId: z.string().startsWith(MOVIE_SOURCE_PREFIX).max(64),
    state: z.enum(['ready', 'missing', 'mismatch', 'error']),
  }),
  subtitles: z.object({
    name: z.string().max(200).transform(sanitizeText).transform((s) => s || 'Subtitles'),
    text: z.string().min(1).max(SUBTITLE_MAX_CHARS),
  }),
  rtcSignal: z.object({ to: userId, signal: rtcSignal }),
  chat: z.object({
    text: z
      .string()
      .max(MAX_CHAT_LENGTH * 4)
      .transform(sanitizeText)
      .refine((s) => s.length > 0, 'Message is empty')
      .refine((s) => codePointLength(s) <= MAX_CHAT_LENGTH, `Messages are limited to ${MAX_CHAT_LENGTH} characters`),
  }),
  reaction: z.object({ emoji: z.enum(REACTION_EMOJIS) }),
};
