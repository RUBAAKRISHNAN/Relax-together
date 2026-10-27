/**
 * Movie room protocol test against a running server.
 * Usage: npm run dev -w server   then   npm run test:movies -w server
 */
import { io, type Socket } from 'socket.io-client';
import type { AckResponse, ClientToServerEvents, RoomSnapshot, ServerToClientEvents, SubtitleInfo } from '@shared/types';

const URL = process.env.SERVER_URL ?? 'http://localhost:3001';
type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let failures = 0;
function check(label: string, cond: unknown, detail?: unknown) {
  if (cond) console.log(`  ✓ ${label}`);
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LOCAL = { kind: 'local', name: 'Night Train', size: 12_000_462, fingerprint: '74xyz:0123456789abcdef', duration: 180 };

async function main() {
  console.log(`Movie smoke test against ${URL}`);
  const { roomId, mode } = (await (await fetch(`${URL}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'movies' }) })).json()) as { roomId: string; mode: string };
  check('movie room created', mode === 'movies');

  const [host, viewer, third] = await Promise.all([connect(), connect(), connect()]);
  let latest: RoomSnapshot | null = null;
  host.on('room:state', (s) => (latest = s));
  await call(host, 'room:join', { roomId, userId: 'movie-host-0001', name: 'Maya' });
  await call(viewer, 'room:join', { roomId, userId: 'movie-viewer-01', name: 'Leo' });
  await call(third, 'room:join', { roomId, userId: 'movie-viewer-02', name: 'Zoe' });

  const viewerLoad = await call(viewer, 'movie:load', { source: LOCAL });
  check('viewers cannot pick the movie', !viewerLoad.ok && viewerLoad.code === 'FORBIDDEN');

  const badUrl = await call(host, 'movie:load', { source: { kind: 'url', name: 'x', url: 'javascript:alert(1)' } });
  check('non-http(s) links are rejected', !badUrl.ok);
  const badPrint = await call(host, 'movie:load', { source: { ...LOCAL, fingerprint: '<script>' } });
  check('malformed fingerprints are rejected', !badPrint.ok);

  const sync = new Promise<{ action: string; isPlaying: boolean; videoId: string | null }>((r) => viewer.once('player:sync', r));
  const load = await call(host, 'movie:load', { source: LOCAL });
  const ev = await sync;
  await sleep(400);
  check('host loads a movie; it starts paused for everyone', load.ok && ev.action === 'load' && !ev.isPlaying);
  check('room state carries the movie source', latest!.video?.movie?.kind === 'local' && latest!.video.videoId === ev.videoId);
  check('host is marked ready, others not yet', latest!.movieReady['movie-host-0001'] === 'ready' && !latest!.movieReady['movie-viewer-01']);

  viewer.emit('movie:ready', { videoId: ev.videoId!, state: 'mismatch' });
  viewer.emit('movie:ready', { videoId: 'movie:stale0000000', state: 'ready' });
  // Wait for the update instead of a fixed delay, so this also works against a remote server.
  for (let i = 0; i < 30 && latest!.movieReady['movie-viewer-01'] !== 'mismatch'; i++) await sleep(100);
  await sleep(300);
  check('readiness is recorded (stale reports ignored)', latest!.movieReady['movie-viewer-01'] === 'mismatch');

  // Subtitles go over HTTP (big files would be dropped by hosting proxies as WebSocket messages).
  const text = '1\n00:00:01,000 --> 00:00:03,000\nHéllo ✓\n' + 'Long line of dialogue. '.repeat(20_000); // ~460 KB
  const postSubs = (token: string, body: string) =>
    fetch(`${URL}/api/rooms/${roomId}/subtitles`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Upload-Token': token, 'X-File-Name': encodeURIComponent('Night Train.srt') },
      body,
    });
  const viewerToken = await call<{ token: string }>(viewer, 'room:uploadToken');
  const viewerPost = await postSubs(viewerToken.ok ? viewerToken.data.token : '', text);
  check('viewers cannot share subtitles for everyone', viewerPost.status === 403);
  const hostToken = await call<{ token: string }>(host, 'room:uploadToken');
  const gotInfo = new Promise<SubtitleInfo | null>((r) => third.once('movie:subtitles', r));
  const hostPost = await postSubs(hostToken.ok ? hostToken.data.token : '', text);
  const info = await Promise.race([gotInfo, sleep(5000).then(() => null)]);
  const fetched = info ? await (await fetch(`${URL}/api/rooms/${roomId}/subtitles?v=${info.version}`)).text() : '';
  check('host shares a 460 KB subtitle file; viewers fetch it', hostPost.status === 201 && fetched === text, `(${hostPost.status}, ${fetched.length} chars)`);
  const huge = await postSubs(hostToken.ok ? hostToken.data.token : '', 'x'.repeat(900_000));
  check('oversized subtitle files are rejected', huge.status === 413);

  const late = await connect();
  const lateSubs = new Promise<SubtitleInfo | null>((r) => late.once('movie:subtitles', r));
  await call(late, 'room:join', { roomId, userId: 'movie-viewer-03', name: 'Ana' });
  check('late joiners receive the shared subtitles', (await Promise.race([lateSubs, sleep(2000).then(() => null)]))?.name === 'Night Train.srt');

  // WebRTC signalling relay: only host <-> viewer.
  const toViewer = new Promise<unknown>((r) => viewer.once('rtc:signal', r));
  host.emit('rtc:signal', { to: 'movie-viewer-01', signal: { type: 'offer', sdp: 'v=0' } });
  const relayed = (await Promise.race([toViewer, sleep(1500).then(() => null)])) as { from: string } | null;
  check('host → viewer signalling is relayed', relayed?.from === 'movie-host-0001');
  let leaked = false;
  third.once('rtc:signal', () => (leaked = true));
  viewer.emit('rtc:signal', { to: 'movie-viewer-02', signal: { type: 'hello' } });
  await sleep(1000);
  check('viewer → viewer signalling is blocked', !leaked);

  const stream = await call(host, 'movie:load', { source: { kind: 'stream', name: 'Live', size: 1, fingerprint: '1:00000000aaaaaaaa', duration: 60 } });
  await sleep(600);
  check('stream source loads and resets readiness', stream.ok && latest!.video?.movie?.kind === 'stream' && Object.keys(latest!.movieReady).length === 1);

  for (const s of [host, viewer, third, late]) s.disconnect();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll movie checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
