# 🛋️ Relax Together

Hang out with friends in real time. Three experiences:

- **YouTube Together**: watch any video or live stream in sync. When the host plays, pauses or seeks, every viewer follows within a few hundred milliseconds.
- **Music Together**: listening parties. Paste a Spotify, Apple Music or YouTube link (whole playlists and albums too), search by song name, or upload songs from your own device, all inside an animated **mood** environment everyone shares.
- **Movies Together**: movie nights. Everyone plays their own copy of the movie (zero streaming lag, full quality), or the host shares a video link or streams the movie from their own device. Includes a ready check, shared subtitles and a dimmed theatre with an ambient glow.

- **Home dashboard**: pick a name, start a watch party, music party or movie night, or join with a code.
- **Moods**: seven animated scenes the host picks for the room (🌸 Cherry Blossom, 🌧️ Rainy Window, 🌙 Starry Night, 🌅 Golden Hour, 🌲 Firefly Forest, 🌊 Ocean Breeze, 🎉 Neon Party). Uploaded songs drive the animation with their real loudness.
- **Rooms**: share a 6-character code or an invite link. No accounts.
- **Live streams**: live videos get a red LIVE badge. The host can rewind (DVR) and everyone follows, and a **Go live** button jumps the whole room back to the live edge.
- **Up next**: YouTube's own recommendations for the current video. Anyone can queue them, the host can play them right away, and **Autoplay** continues with the top unseen suggestion when the queue runs out.
- **Host controls**: only the host can play, pause, seek or change the video, and the server enforces this. The host can hand the role to someone else. If the host drops off, the longest-present member takes over.
- **Chat, reactions and queue**: live chat with emoji, floating ❤️ 😂 🔥 😮 👏 reactions over the video, and a shared queue that plays on automatically.
- **Polished UI**: dark/light themes, glassmorphism, Framer Motion transitions, responsive down to 360px, keyboard shortcuts (Space, ←, →) and accessible controls.

**Stack:** React 18, Vite, TypeScript, Tailwind CSS, Framer Motion, lucide-react · Node, Express, Socket.IO · YouTube IFrame Player API · shared types in `/shared`.

---

## Getting started

Requires **Node 18.18+**.

```bash
npm install          # installs client + server (npm workspaces)
npm run dev          # server on :3001, client on :5173
```

Open http://localhost:5173, create a room, then open the invite link in a second window (or on your phone on the same Wi-Fi via the "Network" URL Vite prints).

Optional env files (the defaults work for local dev):

```bash
cp server/.env.example server/.env
cp client/.env.example client/.env
```

| Variable          | Where  | Purpose                                                                          |
| ----------------- | ------ | -------------------------------------------------------------------------------- |
| `PORT`            | server | Port for HTTP + Socket.IO (default `3001`)                                       |
| `CLIENT_URL`      | server | Allowed browser origin(s) for CORS, comma-separated. Enforced in production only |
| `NODE_ENV`        | server | `production` turns on strict CORS                                                |
| `VITE_SERVER_URL` | client | URL of the server. Defaults to `http://<page-host>:3001` in dev                  |
| `TURN_CLOUDFLARE_KEY_ID` + `TURN_CLOUDFLARE_API_TOKEN` (or `TURN_METERED_DOMAIN` + `TURN_METERED_API_KEY`, or `TURN_URLS`/`TURN_USERNAME`/`TURN_CREDENTIAL`) | server | Optional TURN relay for "stream from my device" on mobile data / strict networks; see `server/.env.example` |

### Scripts

| Command                         | What it does                                                  |
| ------------------------------- | ------------------------------------------------------------- |
| `npm run dev`                   | Runs server and client together (concurrently, hot reload)    |
| `npm run build`                 | Bundles the server (tsup) and builds the client (tsc + vite)  |
| `npm start`                     | Runs the built server                                         |
| `npm run typecheck`             | Type-checks both packages                                     |
| `npm run test:smoke -w server`  | 23-check protocol test against a running server               |
| `npm run test:music -w server`  | Music room test (search, Spotify/Apple links, uploads, moods); hits the real services |
| `npm run test:movies -w server` | Movie room test (sources, ready check, subtitles, WebRTC relay rules)                  |

---

## Project layout

```
shared/               types, constants and the YouTube URL parser, used by both sides
server/src/
  index.ts            Express app (health, room create/lookup) + Socket.IO bootstrap
  socketHandlers.ts   every socket event: validation, host checks, broadcasts
  roomStore.ts        in-memory Map of rooms, snapshots, host promotion
  validation.ts       zod schemas + text sanitizing
  rateLimiter.ts      token-bucket limits per socket and per IP
  oembed.ts           title/author lookup via YouTube oEmbed (cached)
  youtubeWatch.ts     live detection + "up next" suggestions from the YouTube watch page (cached)
  youtubeSearch.ts    YouTube search + best-match scoring for songs (cached)
  musicResolver.ts    Spotify / Apple Music / other music links and searches → playable tracks
  uploads.ts          uploaded songs: validation, tags + cover art, storage, cleanup
  ytJson.ts           helpers for reading YouTube's page data
client/src/
  lib/syncEngine.ts   the sync engine (see below)
  lib/clock.ts        NTP-style server clock
  hooks/useRoomSession.ts  socket lifecycle, join/rejoin, room events
  hooks/useSuggestions.ts  fetches "up next" suggestions for the current video
  hooks/useUploads.ts      uploads songs with progress
  lib/hybridPlayer.ts      one player for music rooms: YouTube iframe or <audio> (+ analyser)
  lib/mediaPlayer.ts       the player interface the sync engine drives
  components/         Home, Room, VideoStage, PlayerControls, Sidebar, Chat/People/Up next panels…
  components/music/   MusicStage, MusicAddBox, MoodPicker, MoodScene + scenes.ts (canvas moods)
  components/movie/   MovieStage, MovieSourcePicker, ReadyCheck, Subtitles, localFiles
  lib/videoElementPlayer.ts  <video> player for movies (local files, MP4/WebM links, HLS via hls.js)
  lib/movieStream.ts         WebRTC "stream from my device" (host → viewers)
  lib/fingerprint.ts         fast movie-file fingerprint + metadata probe
  lib/subtitles.ts           SRT/VTT parsing and encoding detection
```

---

## How the sync engine works

**The server is the source of truth.** Each room stores:

```ts
{ videoId, isPlaying, currentTime, lastUpdatedAt /* server ms */, playbackRate, hostId }
```

This is enough for anyone to work out where the video should be *right now*:

```
expectedTime = currentTime + (serverNow − lastUpdatedAt) / 1000 × playbackRate   (if playing)
```

### 1. Clock sync

Clients can't trust their own clocks, so on connect (and every 30s) each one runs an NTP-style exchange: it sends 5 `time:ping`s, keeps the sample with the lowest round-trip time, and sets `offset = serverTime − (sendTime + rtt/2)`. From then on, `serverNow = Date.now() + offset`, so every client measures `serverNow` on the same clock.

### 2. Commands

When the host plays, pauses or seeks, the player reacts locally right away, and the client emits `player:command { action, videoTime, sentAt }`. The server checks that the sender is the host, validates the payload, and stamps the state. It uses the host's own server-clock reading (`sentAt`), clamped to the last second, because that cancels out upload latency. Then it broadcasts `{ action, videoTime, serverTimestamp }` to the room. Each viewer computes `expectedTime`, seeks if needed, and plays or pauses.

### 3. Drift correction (viewers, every 1s)

| Drift           | Action                                                                    |
| --------------- | ------------------------------------------------------------------------- |
| > 1.0s          | hard `seekTo(expected + seekLead)`, with a 2.5s cooldown                  |
| 0.3s – 1.0s     | nudge the playback rate (1.05/0.95, or the closest speed YouTube allows)  |
| ≤ 0.3s          | nothing                                                                   |

Fine-tuning:

- **Nudge timing:** a nudge runs for exactly `drift / |rate − 1|` seconds, then the rate goes back to 1×. It also stops early if the player overshoots.
- **Settle window:** for 5s after a seek, load or command, the nudge kicks in at 0.12s instead of 0.3s. Different players buffer for different amounts of time, and this cleans up the gap that leaves.
- **Seek lead:** `seekLead` is learned from how far off each hard seek lands. Long stalls are ignored, so a network outage doesn't skew it.

### 4. Heartbeat and late joiners

Every 3s the host sends its real position. The host also re-sends right after recovering from any buffering stall, because the room's timeline kept moving while the host was stuck. A heartbeat is never sent while the host is buffering or blocked, so a stalled player can't drag everyone backwards. New members, and anyone reconnecting, receive the room snapshot on join and jump straight to `expectedTime`.

### 5. No echo loops

Every programmatic player call (`seekTo`, `playVideo`, …) opens a short guard window. State changes inside that window are known to be ours and are never re-emitted. Outside the window, changes are treated as real user input. On the host, a media-key pause gets broadcast. On a viewer, the room's state is put back, since viewers can't pause the room.

### 6. Edge cases

- **Buffering:** after 1.5s of buffering a viewer sees "Catching up…", and on recovery it resyncs immediately. The pill turns yellow after 0.5s.
- **Autoplay blocking:** if `play()` doesn't take effect within 2s, or two retries fail, a big "Tap to join playback" overlay appears. The tap counts as a user gesture, so it can unmute, seek to `expectedTime` and play. Invite links open on a short "pick a name and join" card first, so that click usually satisfies the autoplay policy before the room even loads.
- **Reconnects:** Socket.IO reconnects automatically. Each tab keeps a stable user id (`sessionStorage`), so rejoining puts you back in the same seat with the same host status. The server holds a disconnected seat for 5s, so a refresh doesn't trigger "left" toasts or a host change.

### 7. Live streams

Live streams need two adjustments, both found by measuring real streams:

- **Opening at the live edge.** For a live stream, `startSeconds: 0` means the start of its DVR window, which can be 12 hours old. So when there's no explicit timestamp the player loads without `startSeconds` and opens at the live edge. The host's first-play anchor then puts everyone on the host's exact position. Positions on 24/7 streams run into the millions of seconds, so the server accepts video times up to 10⁹.
- **Measuring "behind live".** On live streams `getDuration()` isn't the live edge. Instead the player's media reference time, the wall-clock time of the frame on screen, is compared with now. The smallest gap seen (YouTube's own latency, capped at 30s) counts as "live". The badge is red within 10s of that, and otherwise shows "−m:ss". **Go live** seeks past the end, which lands on the edge, and broadcasts the real position as soon as the player gets there.

Drift correction itself is unchanged, since every viewer seeks to the same absolute position in the stream.

### Measured results

Two Chrome windows on the same machine, driven by Playwright, comparing raw `getCurrentTime()` values:

| Scenario                  | Typical drift |
| ------------------------- | ------------- |
| Late join while playing   | 20–35 ms      |
| Pause                     | 15–45 ms      |
| Seek while paused         | 0 ms          |
| Resume                    | ≈10 ms        |
| Seek while playing        | ≈25 ms        |
| Steady state              | ≈25 ms        |
| Live stream (at the edge) | 20–45 ms      |
| Live stream, 1 min behind | ≈50 ms        |

---

## Music Together

### Where songs come from

| You paste or type…                          | What happens                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A song name ("weightless marconi union")    | Live search results as you type; pick one to play or queue                                                               |
| A YouTube / YouTube Music link              | Plays directly                                                                                                           |
| A Spotify **track**                         | Title, artists and exact length come from Spotify's public embed page, then the best match on YouTube plays              |
| A Spotify **album** or **playlist**         | Up to 50 songs are queued at once and matched to YouTube in the background (two at a time); the first plays immediately |
| An Apple Music song or album                | Read through Apple's public iTunes lookup API, then matched the same way                                                 |
| JioSaavn, Gaana, SoundCloud, Deezer, …      | Title and artist are read from the page's metadata, then matched                                                         |
| Files from your phone or computer           | Uploaded and streamed to everyone (MP3, M4A/AAC, FLAC, WAV, OGG/Opus, WebM; up to 50 MB each)                            |

**Why match to YouTube?** Spotify, Apple Music and the rest only allow playback inside their own apps or SDKs, and those need every listener to log in (Spotify's needs Premium). Finding the same recording on YouTube lets everyone in the room hear it with no accounts. The matcher prefers the right length (within a few seconds), the artist's own channel, "- Topic" channels and "Official Audio" uploads. It avoids covers, remixes, live, slowed and 8D versions unless you asked for them.

Only an allow-list of music services is fetched from the server. Arbitrary links are refused, so the server can't be used to probe other sites or internal networks.

### Uploads

- Uploading needs a short-lived token handed to room members over their socket, so outsiders can't push files into a room.
- Every file is parsed with `music-metadata`. Anything that isn't real audio is rejected, and the title, artist, album, duration and embedded cover art are read from its tags.
- Files are served from `/media/:room/:id` with Range support (instant seeking), `nosniff` and a sandboxing CSP. Limits are 50 MB per file, 40 files or 500 MB per room, and 4 GB per server. Files are deleted with the room, and the upload folder is wiped on restart.
- Drag and drop works anywhere on a music room page. The next uploaded song in the queue is preloaded, so it starts without a gap.

### One player, two sources

`HybridPlayer` looks exactly like the YouTube player to the sync engine (same methods, same state numbers), so the sync logic shared with watch parties is unchanged:

- **Streamed songs** play in the YouTube player, shown as the album art (cropped square). The cover art stays on top while YouTube shows its own loading overlays.
- **Uploaded songs** play in an `<audio>` element. Catch-up nudges use 0.97×/1.03× with pitch preserved, which you can't hear. An `AnalyserNode` measures loudness, so the scenes react to the beat. It's only connected once the browser's AudioContext is running, because a suspended one would silence the song.

Measured in two browsers: uploaded songs stay within **0–100 ms**, and pause and seek land exactly (0 ms). YouTube songs settle within a few seconds of joining and then stay within about **150 ms**.

### Moods

Each mood is a canvas scene (`components/music/scenes.ts`): static scenery is painted once onto a backdrop layer, and only light particles (petals, rain, fireflies, stars, waves, confetti) are animated. To keep the music smooth on modest hardware:

- Scenes run at 30 fps with a ~1 megapixel budget (CSS scales them up; soft scenes don't need retina detail).
- Quality adapts: if frames get slow, the resolution drops automatically.
- Glass panels use a smaller blur radius in music rooms (a blur over a moving background is redrawn every frame).
- Everyone has an **Effects on/off** switch for their own device (saved in the browser). `prefers-reduced-motion` shows a still frame.

The host picks the mood (`room:mood`, server-enforced); it's part of the room state, so late joiners get it too.

---

## Movies Together

### Choosing how to watch

Uploading full movies to a server (1–4 GB each, re-sent to every viewer) would be slow, expensive and a copyright liability for whoever runs the server. Instead the host picks one of three ways, none of which sends the movie through our server:

| Mode | How it works | Lag / quality | Best for |
| --- | --- | --- | --- |
| **📁 Everyone has the file** (recommended) | Each person opens their own copy. It plays straight from their disk; only play/pause/seek positions are synced | **No streaming at all**: full original quality, works on any connection | Groups who can share the file beforehand |
| **🔗 Video link** | Everyone's browser streams the same `.mp4`/`.webm` link or HLS `.m3u8` playlist (via hls.js); the sync engine keeps them together | Depends on the source's speed | Movies already online (Dropbox, your own storage) |
| **📡 Stream from my device** | The host's browser captures the playing movie (`captureStream()`) and sends it peer-to-peer over WebRTC (≈4 Mbps per viewer) | ≈0.2–0.5 s, and everyone sees exactly the host's picture | Only the host has the file; about 2–5 viewers |

### Everyone has the file

- **Version check:** each file gets a fingerprint (its size plus a hash of three 256 KB samples), which takes milliseconds even for a 4 GB file and needs no upload. A viewer with a different rip still plays but sees a warning, and the host's **ready check** shows "Different version".
- **Late joiners** see where the room is ("the room is at 1:02:13"), open their copy and land right there.
- **Instant correction:** a local file seeks instantly and frame-accurately, so the engine fixes drift with a seek instead of a slow speed nudge. That's what `hasInstantSeek()` on the player is for.
- **Browser support:** MP4 (H.264 + AAC) and WebM play everywhere, and most MKV files play in Chrome and Edge. Files whose picture the browser can't decode (often HEVC/x265) are caught when picked, or flagged with a "sound only" warning.

### Stream from my device

- The server only relays the small signalling messages (offer/answer/ICE), and only between the host and a viewer. Viewers can't signal each other.
- **Session ids:** every connection attempt has its own id, carried by its answer and ICE candidates. Messages from an older attempt are ignored, so a viewer's "hello" racing the host's viewer list (or a retry) can't cross-wire two handshakes. Early candidates are queued by session until their offer is applied.
- **Self-healing:** viewers retry with backoff if a connection fails, drops for more than 5 s, or never gets an offer, and they re-ask after a socket reconnect. The host replaces a viewer's connection whenever that viewer says hello.
- **TURN relay:** peer-to-peer works on most home networks using STUN. Mobile data and strict NATs need a **TURN relay**. Configure one provider on the *server* (Cloudflare Realtime TURN, Metered, or your own coturn; see `server/.env.example`). The server hands out short-lived credentials at `/api/ice`, so no secret ends up in the website. Without TURN, an affected viewer sees "couldn't connect" with a retry button.
- Hosting needs `captureStream()`: Chrome, Edge, Firefox or Safari 17+. Viewers can use any modern browser.

### Subtitles and theatre

- **Shared subtitles:** the host shares an SRT/VTT file with the room. It goes over the socket (up to 800 KB, rate limited) and is re-sent to late joiners.
- **Your own subtitles:** anyone can load a personal file instead. Size and a ±0.5 s timing fix are per person and remembered.
- **Encodings:** files are read as UTF-8, then UTF-16 (BOM), then Windows-1252, so accents and non-Latin scripts display correctly.
- **Theatre:** a dark backdrop, plus an **ambilight** glow made by drawing the current frame into a tiny canvas a few times a second (cheap, and it works even for cross-origin video because no pixels are read back), full-screen, reactions and chat.

Measured in Chrome with two or three viewers:

| Scenario | Drift |
| --- | --- |
| Own copies: play, pause, seek, resume | 0–14 ms |
| Late joiner with a different rip | locks in ≈3 s, then ≈90–220 ms |
| MP4 link | ≈45–80 ms |
| HLS link | ≈15–50 ms |
| Stream from device | the live picture itself; pausing freezes everyone's frame |

---

## Up next suggestions

YouTube's Data API no longer offers related videos, and it needs a key anyway. Instead the server reads the public watch page (`/api/videos/:id/suggestions`), the same page a logged-out browser gets, and pulls out the "up next" list (title, channel, duration or LIVE, views) plus whether the video is live. Results are cached for 10 minutes (2 for live), shared between rooms, and rate-limited per IP.

YouTube changes that page from time to time, so the parser is defensive: it handles both the current `lockupViewModel` items and the older `compactVideoRenderer` ones. If parsing fails, the panel shows "No suggestions" and everything else keeps working. Scraping is a gray area under YouTube's Terms of Service. If you need something officially supported, swap `youtubeWatch.ts` for YouTube Data API search results (for example a search on the current video's title or channel).

**Autoplay** (on by default, host toggle): when a video ends, the host's client plays the next queued item, or failing that the top suggestion nobody in this session has watched yet.

---

## Security and reliability

- **Validation:** every socket payload is checked with zod. Acks are optional and type-checked, and handlers can't crash the process.
- **Host-only actions** (play, pause, seek, load, queue play, transfer, autoplay, mood, movie, shared subtitles) are enforced on the server.
- **Movies never pass through the server.** Links are validated as plain http(s) and loaded by each browser; WebRTC signalling is relayed only between the host and a viewer, with size limits.
- **Uploads** need a per-member token, are validated as real audio, and are served with `nosniff` + a sandboxing CSP.
- **Outbound fetches** (music links) are limited to an allow-list of music services, so there's no open proxy or SSRF.
- **Chat sanitizing:** control and bidi-override characters are stripped, messages are capped at 500 characters, and React escapes everything on render.
- **Rate limits:** token buckets per socket for chat, reactions, controls, video loads, queue, moods and pings, plus per-IP limits on room creation, suggestions, music search and uploads.
- **Cleanup:** rooms are deleted 10 minutes after the last person leaves.
- **Video checks:** private and non-embeddable videos are caught through oEmbed before anyone loads them. Player error codes are shown in plain language.

---

## Deploying

The server holds rooms in memory, so run **exactly one server instance**. Horizontal scaling would need a shared store such as the Socket.IO Redis adapter plus a room store in Redis.

### Server → Render

1. New **Web Service** from your repo, with the root directory left as the repo root.
2. **Build command:** `npm install --include=dev && npm run build -w server`
3. **Start command:** `npm start -w server`
4. **Environment:** `NODE_ENV=production` and `CLIENT_URL=https://your-app.vercel.app`. Render provides `PORT` itself.
5. Health check path: `/health`.

`render.yaml` in the repo root sets all of this up as a Blueprint. Note that free Render instances sleep when idle, and that wipes every room.

### Server → Railway

New project from your repo. Set the build command to `npm install --include=dev && npm run build -w server`, the start command to `npm start -w server`, and the same environment variables. Railway also injects `PORT`.

### Client → Vercel

The repo-root `vercel.json` already holds the build settings (install at the root so the client can import `../shared`, build the client workspace, serve `client/dist`, and rewrite every route to `index.html` so `/room/ABC123` links work).

1. In Vercel, choose **Add New → Project** and import the GitHub repo. Leave **Root Directory** as the repo root, and leave the framework preset as **Other**; `vercel.json` takes care of the rest.
2. Add the environment variable `VITE_SERVER_URL=https://your-server.onrender.com`.
3. Deploy. The CLI works too: run `vercel --prod` from the repo root.

After both are deployed, make sure the server's `CLIENT_URL` exactly matches the Vercel URL (no trailing slash). Add preview URLs separated by commas if you need them.

---

## Limitations and next steps

- Playback rate is fixed at 1× for the room. Custom room speeds would need a host control and are already part of the state model.
- Playlist-only links (`?list=` without `v=`) are rejected with a hint to copy a specific video's link.
- Rooms disappear when the server restarts. A Redis-backed store would fix that.
- **Movies:** an opened file can't survive a page refresh (browsers don't let a page reopen files by itself), so after a refresh you pick your copy again. "Stream from my device" is limited by the host's upload speed and has no TURN relay by default.
- **Uploaded songs live on the server's local disk.** On Render's free tier that disk is ephemeral (fine, since rooms are in-memory too), but a multi-instance setup would need object storage such as S3 or R2.
- **Music matching and suggestions read public YouTube, Spotify and Apple pages.** That's unofficial: a change on their side can break it, and scraping is a gray area under their terms. Failures degrade gracefully (a "couldn't find" message; everything else keeps working).
