/**
 * Music room smoke test against a running server (hits YouTube, Spotify and iTunes for real).
 * Usage: npm run dev -w server   then   npm run test:music -w server
 */
import { io, type Socket } from 'socket.io-client';
import type { AckResponse, ClientToServerEvents, RoomSnapshot, ServerToClientEvents, SyncEvent, UploadResponse } from '@shared/types';

const URL = process.env.SERVER_URL ?? 'http://localhost:3001';
type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let failures = 0;
function check(label: string, cond: unknown, detail?: unknown) {
  if (cond) console.log(`  ✓ ${label}`, detail !== undefined ? `→ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '');
  else {
    failures++;
    console.log(`  ✗ ${label}`, detail ?? '');
  }
}

const connect = () =>
  new Promise<Client>((resolve, reject) => {
    const s: Client = io(URL, { transports: ['websocket'], forceNew: true });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });

const call = <T>(s: Client, event: string, ...args: unknown[]) =>
  new Promise<AckResponse<T>>((resolve) =>
    (s as unknown as { emit: (...a: unknown[]) => void }).emit(event, ...args, (res: AckResponse<T>) => resolve(res)),
  );

let latest: RoomSnapshot | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A 2-second 440 Hz mono WAV, generated in memory. */
function makeWav(): Buffer {
  const rate = 8000;
  const samples = rate * 2;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
  return buf;
}

async function main() {
  console.log(`Music smoke test against ${URL}`);
  const created = (await (await fetch(`${URL}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'music' }) })).json()) as { roomId: string; mode: string };
  check('music room created', created.mode === 'music', created.roomId);
  const { roomId } = created;

  const host = await connect();
  const viewer = await connect();
  host.on('room:state', (s) => (latest = s));
  const hj = await call<{ snapshot: RoomSnapshot }>(host, 'room:join', { roomId, userId: 'music-host-0001', name: 'Asha' });
  check('host joins; room starts in the calm mood', hj.ok && hj.data.snapshot.mood === 'calm' && hj.data.snapshot.mode === 'music');
  await call(viewer, 'room:join', { roomId, userId: 'music-viewer-001', name: 'Ravi' });

  // Plain-text search → plays the best match.
  const loaded = new Promise<SyncEvent>((r) => viewer.once('player:sync', r));
  const t0 = Date.now();
  const byName = await call(host, 'player:load', { url: 'blinding lights the weeknd' });
  const ev = await loaded;
  await sleep(100);
  check('song name search plays the official audio', byName.ok && ev.action === 'load' && /blinding lights/i.test(latest?.video?.title ?? ''), `${latest?.video?.title} (${Date.now() - t0} ms)`);

  // Spotify track → matched on YouTube with Spotify's title, artist and cover.
  const spotify = await call(host, 'queue:add', { url: 'https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc' });
  await sleep(100);
  const sItem = latest?.queue.at(-1);
  check('Spotify track link resolves', spotify.ok && sItem?.video.origin === 'spotify' && sItem.video.videoId.length === 11, `${sItem?.video.title} – ${sItem?.video.author} → ${sItem?.video.videoId}`);

  // Apple Music song.
  const apple = await call(host, 'queue:add', { url: 'https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378615' });
  await sleep(100);
  const aItem = latest?.queue.at(-1);
  check('Apple Music song link resolves', apple.ok && aItem?.video.origin === 'apple', `${aItem?.video.title} – ${aItem?.video.author}`);

  // Spotify album → many entries, matched in the background.
  const album = await call(host, 'queue:add', { url: 'https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj' });
  await sleep(100);
  const resolvingNow = latest?.queue.filter((q) => q.status === 'resolving').length ?? 0;
  check('Spotify album adds all its songs', album.ok && (latest?.queue.length ?? 0) >= 14, `${latest?.queue.length} in queue, ${resolvingNow} resolving`);
  for (let i = 0; i < 60 && latest?.queue.some((q) => q.status === 'resolving'); i++) await sleep(500);
  const failed = latest?.queue.filter((q) => q.status === 'failed').length ?? 0;
  check('album songs get matched in the background', !latest?.queue.some((q) => q.status === 'resolving') && failed <= 1, `${failed} failed`);

  const unknown = await call(host, 'queue:add', { url: 'https://example.com/song/123' });
  check('unknown sites are refused (no arbitrary fetching)', !unknown.ok, !unknown.ok ? unknown.error : '');

  // Mood is host-only.
  const viewerMood = await call(viewer, 'room:mood', { mood: 'party' });
  check('viewer cannot change the mood', !viewerMood.ok && viewerMood.code === 'FORBIDDEN');
  const hostMood = await call(host, 'room:mood', { mood: 'rain' });
  await sleep(100);
  check('host sets the mood for everyone', hostMood.ok && latest?.mood === 'rain');
  const badMood = await call(host, 'room:mood', { mood: 'disco-inferno' });
  check('unknown moods are rejected', !badMood.ok);

  // Uploads.
  const token = await call<{ token: string }>(viewer, 'music:uploadToken');
  check('room member gets an upload token', token.ok);
  const upload = (headers: Record<string, string>, body: Buffer) =>
    fetch(`${URL}/api/rooms/${roomId}/uploads`, { method: 'POST', headers, body: new Uint8Array(body) });
  const wav = makeWav();
  const up = await upload({ 'Content-Type': 'audio/wav', 'X-File-Name': encodeURIComponent('My Song.wav'), 'X-Upload-Token': token.ok ? token.data.token : '' }, wav);
  const upBody = (await up.json()) as UploadResponse;
  check('WAV upload accepted and queued', up.status === 201 && upBody.placement === 'queued' && upBody.track.videoId.startsWith('file:'), `${upBody.track?.title} (${upBody.track?.durationSec}s)`);

  const fileId = upBody.track.videoId.slice(5);
  const ranged = await fetch(`${URL}/media/${roomId}/${fileId}`, { headers: { Range: 'bytes=0-99' } });
  check('uploaded audio streams with Range support', ranged.status === 206 && ranged.headers.get('content-type') === 'audio/wav' && (await ranged.arrayBuffer()).byteLength === 100);
  check('media is served with a sandbox CSP + nosniff', ranged.headers.get('x-content-type-options') === 'nosniff' && /sandbox/.test(ranged.headers.get('content-security-policy') ?? ''));

  const fake = await upload({ 'Content-Type': 'audio/mpeg', 'X-File-Name': 'evil.mp3', 'X-Upload-Token': token.ok ? token.data.token : '' }, Buffer.from('<html><script>alert(1)</script></html>'));
  check('non-audio files are rejected', fake.status === 415, `${fake.status} ${((await fake.json()) as { error: string }).error}`);
  const noToken = await upload({ 'Content-Type': 'audio/wav' }, wav);
  check('uploads without a token are rejected', noToken.status === 403);

  const search = (await (await fetch(`${URL}/api/music/search?q=${encodeURIComponent('kesariya arijit')}`)).json()) as { results: { title: string }[] };
  check('music search returns results', search.results.length > 3, search.results[0]?.title);

  host.disconnect();
  viewer.disconnect();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll music checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
