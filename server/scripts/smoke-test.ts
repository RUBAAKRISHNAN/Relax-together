/**
 * Protocol smoke test: two socket clients exercise the room + sync protocol against a running server.
 * Usage: npm run dev -w server   (in another terminal)  then  npm run test:smoke -w server
 */
import { io, type Socket } from 'socket.io-client';
import type { AckResponse, ClientToServerEvents, ServerToClientEvents, SyncEvent } from '@shared/types';

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

// Typed-event generics don't play well with a generic "emit with ack" helper, so this one is loosely typed.
const call = <T>(s: Client, event: string, ...args: unknown[]) =>
  new Promise<AckResponse<T>>((resolve) =>
    (s as unknown as { emit: (...a: unknown[]) => void }).emit(event, ...args, (res: AckResponse<T>) => resolve(res)),
  );

const next = <E extends keyof ServerToClientEvents>(s: Client, event: E, timeout = 3000) =>
  new Promise<Parameters<ServerToClientEvents[E]>[0]>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    (s as unknown as { once: (e: string, cb: (v: unknown) => void) => void }).once(event, (v) => {
      clearTimeout(t);
      resolve(v as Parameters<ServerToClientEvents[E]>[0]);
    });
  });

async function main() {
  console.log(`Smoke testing ${URL}`);
  const { roomId } = (await (await fetch(`${URL}/api/rooms`, { method: 'POST' })).json()) as { roomId: string };
  check('room created over HTTP', /^[A-Z0-9]{6}$/.test(roomId), roomId);

  const host = await connect();
  const viewer = await connect();

  const pingStart = Date.now();
  const serverTime = await new Promise<number>((r) => host.emit('time:ping', r));
  check('time:ping returns server time', Math.abs(serverTime - pingStart) < 5000);

  const hostJoin = await call<{ selfId: string; snapshot: { hostId: string } }>(host, 'room:join', { roomId, userId: 'host-user-1234', name: 'Alice' });
  check('host joins and becomes host', hostJoin.ok && hostJoin.data.snapshot.hostId === 'host-user-1234', hostJoin);

  const joinedNotice = next(host, 'room:notice');
  const viewerJoin = await call<{ snapshot: { members: unknown[] } }>(viewer, 'room:join', { roomId: roomId.toLowerCase(), userId: 'viewer-user-1234', name: 'Bob' });
  check('viewer joins (case-insensitive code)', viewerJoin.ok && viewerJoin.data.snapshot.members.length === 2, viewerJoin);
  check('host is notified of the join', (await joinedNotice).kind === 'joined');

  const badJoin = await call(viewer, 'room:join', { roomId: 'ZZZZZZ', userId: 'viewer-user-1234', name: 'Bob' });
  check('joining a missing room fails with ROOM_NOT_FOUND', !badJoin.ok && badJoin.code === 'ROOM_NOT_FOUND', badJoin);
  // The failed join must not have detached the viewer from its room.
  await call(viewer, 'room:join', { roomId, userId: 'viewer-user-1234', name: 'Bob' });

  const forbidden = await call(viewer, 'player:load', { url: 'https://youtu.be/dQw4w9WgXcQ' });
  check('viewer cannot load videos (server-side enforcement)', !forbidden.ok && forbidden.code === 'FORBIDDEN', forbidden);

  const invalid = await call(host, 'player:load', { url: 'https://vimeo.com/123' });
  check('invalid URL is rejected with a message', !invalid.ok && /YouTube/.test(invalid.error), invalid);

  const loadSync = next(viewer, 'player:sync');
  const load = await call(host, 'player:load', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123' });
  check('host loads a video', load.ok, load);
  const loaded = (await loadSync) as SyncEvent;
  check('viewer receives load with timestamp start', loaded.action === 'load' && loaded.videoId === 'dQw4w9WgXcQ' && loaded.videoTime === 42, loaded);

  const pauseSync = next(viewer, 'player:sync');
  const sentAt = Date.now();
  host.emit('player:command', { action: 'pause', videoTime: 50, sentAt });
  const paused = (await pauseSync) as SyncEvent;
  check('pause is broadcast with server timestamp', paused.action === 'pause' && !paused.isPlaying && paused.videoTime === 50 && paused.serverTimestamp >= sentAt - 1000, paused);

  const seekSync = next(viewer, 'player:sync');
  host.emit('player:command', { action: 'seek', videoTime: 120, sentAt: Date.now() });
  const seeked = (await seekSync) as SyncEvent;
  check('seek is broadcast', seeked.action === 'seek' && seeked.videoTime === 120, seeked);

  const playSync = next(viewer, 'player:sync');
  host.emit('player:command', { action: 'play', videoTime: 120, sentAt: Date.now() - 60_000 });
  const played = (await playSync) as SyncEvent;
  check('play is broadcast; bogus host timestamps are clamped', played.isPlaying && Date.now() - played.serverTimestamp < 1500, played);

  let viewerGotEcho = false;
  host.once('player:sync', () => (viewerGotEcho = true));
  viewer.emit('player:command', { action: 'pause', videoTime: 0, sentAt: Date.now() });
  await new Promise((r) => setTimeout(r, 300));
  check('viewer pause is ignored by server', !viewerGotEcho);

  const hb = next(viewer, 'player:sync');
  host.emit('player:heartbeat', { videoTime: 125, isPlaying: true, sentAt: Date.now() });
  check('heartbeat reaches viewers', ((await hb) as SyncEvent).action === 'heartbeat');

  const msg = next(viewer, 'chat:message');
  const sent = await call(host, 'chat:send', { text: '  hello <b>there</b> 🎉‮ ' });
  const received = await msg;
  check('chat message delivered and sanitized', sent.ok && received.text === 'hello <b>there</b> 🎉', received);

  const tooLong = await call(host, 'chat:send', { text: 'x'.repeat(501) });
  check('501-char message rejected', !tooLong.ok, tooLong);

  let limited = false;
  for (let i = 0; i < 10; i++) {
    const r = await call(viewer, 'chat:send', { text: `spam ${i}` });
    if (!r.ok && r.code === 'RATE_LIMITED') limited = true;
  }
  check('chat is rate limited', limited);

  const queued = await call(viewer, 'queue:add', { url: 'https://youtube.com/shorts/aqz-KE-bpKQ' });
  check('viewer can suggest to the queue', queued.ok, queued);

  const transferState = next(viewer, 'room:state');
  const transfer = await call(host, 'host:transfer', { userId: 'viewer-user-1234' });
  check('host transfers host role', transfer.ok && (await transferState).hostId === 'viewer-user-1234', transfer);

  const oldHostCmd = await call(host, 'player:command', { action: 'pause', videoTime: 1, sentAt: Date.now() });
  check('former host loses control', !oldHostCmd.ok && oldHostCmd.code === 'FORBIDDEN');

  // Host disconnects → after the grace period the oldest remaining member is promoted.
  const promoted = next(host, 'room:notice', 8000);
  viewer.disconnect();
  const notice = await promoted.catch((e) => ({ kind: 'error', text: String(e) }));
  check('disconnected host is auto-replaced', notice.kind === 'left' || notice.kind === 'host', notice);
  const state = (await (await fetch(`${URL}/api/rooms/${roomId}`)).json()) as { memberCount: number };
  check('room still exists with the remaining member', state.memberCount === 1, state);

  host.disconnect();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
