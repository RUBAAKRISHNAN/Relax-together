import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Clapperboard, FolderOpen, Link2, Loader2, Maximize, Minimize, Play, Radio, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MovieReadyState, RoomSnapshot, SubtitleTrack } from '@shared/types';
import type { FloatingReaction, RoomActions } from '../../hooks/useRoomSession';
import { fingerprintFile, formatBytes } from '../../lib/fingerprint';
import { formatTime } from '../../lib/format';
import { StreamHost, StreamViewer, type ViewerState, captureVideo } from '../../lib/movieStream';
import type { AppSocket } from '../../lib/socket';
import { parseSubtitles } from '../../lib/subtitles';
import type { EngineState, SyncEngine } from '../../lib/syncEngine';
import { VideoElementPlayer, type VideoSource } from '../../lib/videoElementPlayer';
import { FloatingReactions } from '../FloatingReactions';
import { PlayerControls } from '../PlayerControls';
import { ReactionBar } from '../ReactionBar';
import { useToast } from '../Toasts';
import { MOVIE_ACCEPT, localCopy, rememberFile, rememberFileForMovie } from './localFiles';
import { MovieSourcePicker } from './MovieSourcePicker';
import { ReadyCheck } from './ReadyCheck';
import { SubtitleOverlay, SubtitlePanel, useSubtitleSettings } from './Subtitles';

interface MovieStageProps {
  engine: SyncEngine;
  state: EngineState;
  snapshot: RoomSnapshot;
  selfId: string;
  isHost: boolean;
  reactions: FloatingReaction[];
  actions: RoomActions;
  socket: AppSocket;
  sharedSubtitles: SubtitleTrack | null;
}

const canFullscreen = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
const KIND_LABELS = {
  local: { icon: FolderOpen, text: "Everyone's own copy" },
  url: { icon: Link2, text: 'Streaming a link' },
  stream: { icon: Radio, text: 'Live from the host' },
} as const;

export function MovieStage({ engine, state, snapshot, selfId, isHost, reactions, actions, socket, sharedSubtitles }: MovieStageProps) {
  const toast = useToast();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamVideoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<VideoElementPlayer | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const [fileVersion, setFileVersion] = useState(0);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [noPicture, setNoPicture] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [streamState, setStreamState] = useState<ViewerState>('waiting');
  const [streamNeedsTap, setStreamNeedsTap] = useState(false);
  const [streamMuted, setStreamMuted] = useState(false);
  const [peerStates, setPeerStates] = useState<Record<string, RTCPeerConnectionState>>({});
  const [personalSubs, setPersonalSubs] = useState<SubtitleTrack | null>(null);
  const [subSettings, setSubSettings] = useSubtitleSettings();

  const video = snapshot.video;
  const movie = video?.movie;
  const videoId = video?.videoId ?? null;
  const kind = movie?.kind;
  const host = snapshot.members.find((m) => m.id === snapshot.hostId);
  const streamViewer = kind === 'stream' && !isHost;
  // fileVersion forces a re-check after someone opens their copy.
  const local = useMemo(() => localCopy(video), [video, fileVersion]);
  const needsFile = !!movie && (kind === 'local' || (kind === 'stream' && isHost)) && !local;

  // ---------------------------------------------------------------- player

  /** What this device can play for the room's movie right now. */
  const resolve = useCallback((id: string): VideoSource | null => {
    const v = snapshotRef.current.video;
    if (!v?.movie || v.videoId !== id) return null;
    if (v.movie.kind === 'url') return { src: v.movie.url, hls: /\.m3u8($|\?)/i.test(v.movie.url) };
    const copy = localCopy(v);
    return copy ? { src: copy.url, hls: false } : null;
  }, []);

  useEffect(() => {
    const player = new VideoElementPlayer(videoRef.current!, resolve, {
      onStateChange: (s) => engine.onPlayerStateChange(s),
      onError: (code) => engine.onPlayerError(code),
      onNoPicture: () => setNoPicture(true),
    });
    playerRef.current = player;
    return () => {
      engine.detachPlayer();
      player.destroy();
      playerRef.current = null;
    };
  }, [engine, resolve]);

  // Stream viewers watch the host's live picture instead, so the sync engine has nothing to drive.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    if (streamViewer) engine.detachPlayer();
    else engine.attachPlayer(player);
  }, [engine, streamViewer]);

  useEffect(() => {
    setMismatch(null);
    setNoPicture(false);
  }, [videoId]);

  // If the load arrived before this device could play the movie (details not in yet, or the file
  // only just opened), try again as soon as it can.
  useEffect(() => {
    if (videoId && !streamViewer && playerRef.current?.isWaitingForSource && resolve(videoId)) engine.reload();
  }, [engine, resolve, videoId, local, kind, streamViewer]);

  /** Someone opened their copy: check it's the same version and jump to where the room is. */
  const openCopy = async (file: File) => {
    if (!movie || movie.kind === 'url' || !videoId) return;
    const fingerprint = await fingerprintFile(file);
    if (fingerprint === movie.fingerprint) {
      rememberFile(fingerprint, file);
      setMismatch(null);
    } else {
      rememberFileForMovie(videoId, file);
      setMismatch(
        file.size === movie.size
          ? 'Your file has the same size but different content. It may still line up.'
          : `Your copy is a different version (${formatBytes(file.size)} vs ${formatBytes(movie.size)}). If it's the same cut it will still line up; otherwise expect an offset.`,
      );
    }
    setFileVersion((n) => n + 1);
    engine.reload();
  };

  // ---------------------------------------------------------------- readiness

  const reported = useRef<string>('');
  useEffect(() => {
    if (!videoId || !kind) return;
    let ready: MovieReadyState;
    if (kind === 'stream' && !isHost) ready = streamState === 'connected' ? 'ready' : streamState === 'failed' ? 'error' : 'missing';
    else if (state.error) ready = 'error';
    else if (kind === 'url') ready = 'ready';
    else ready = !local ? 'missing' : mismatch ? 'mismatch' : 'ready';
    const key = `${videoId}:${ready}`;
    if (reported.current === key) return;
    reported.current = key;
    actions.reportMovieReady(videoId, ready);
  }, [videoId, kind, isHost, streamState, state.error, local, mismatch, actions]);

  // ---------------------------------------------------------------- streaming (host)

  const streamHostRef = useRef<StreamHost | null>(null);
  const hostStreaming = kind === 'stream' && isHost && !!local;
  useEffect(() => {
    if (!hostStreaming) return;
    const el = videoRef.current!;
    const host = new StreamHost(socket, setPeerStates);
    streamHostRef.current = host;
    let captured: MediaStream | null = null;
    const capture = () => {
      const stream = captureVideo(el);
      if (!stream) {
        toast("This browser can't stream a movie. Use Chrome, Edge or Firefox to host.", 'error');
        return;
      }
      if (stream === captured) return;
      captured = stream;
      // Tracks are swapped when the picture/sound restarts; reconnect viewers with the new ones.
      stream.onaddtrack = () => host.setStream(new MediaStream(stream.getTracks()));
      host.setStream(stream);
    };
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) capture();
    el.addEventListener('loadeddata', capture);
    return () => {
      el.removeEventListener('loadeddata', capture);
      host.stop();
      streamHostRef.current = null;
      setPeerStates({});
    };
  }, [hostStreaming, socket, toast, videoId]);

  const viewerIds = snapshot.members.filter((m) => m.online && m.id !== selfId).map((m) => m.id).join(',');
  useEffect(() => {
    streamHostRef.current?.setViewers(viewerIds ? viewerIds.split(',') : []);
  }, [viewerIds, hostStreaming]);

  // ---------------------------------------------------------------- streaming (viewer)

  const streamViewerRef = useRef<StreamViewer | null>(null);
  useEffect(() => {
    if (!streamViewer || !snapshot.hostId) return;
    const viewer = new StreamViewer(socket, setRemoteStream, setStreamState);
    streamViewerRef.current = viewer;
    viewer.connect(snapshot.hostId);
    return () => {
      viewer.stop();
      streamViewerRef.current = null;
      setRemoteStream(null);
      setStreamState('waiting');
    };
  }, [streamViewer, snapshot.hostId, socket, videoId]);

  useEffect(() => {
    const el = streamVideoRef.current;
    if (!el) return;
    el.srcObject = remoteStream;
    if (remoteStream) void el.play().then(() => setStreamNeedsTap(false)).catch(() => setStreamNeedsTap(true));
  }, [remoteStream]);

  // ---------------------------------------------------------------- fullscreen + subtitles

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrapperRef.current?.requestFullscreen().catch(() => {});
  };

  const cues = useMemo(() => parseSubtitles((personalSubs ?? sharedSubtitles)?.text ?? ''), [personalSubs, sharedSubtitles]);
  // The live stream reaches viewers a fraction of a second after the host's position.
  const subtitleTime = useCallback(
    () => (streamViewer ? engine.positionNow() - 0.3 : videoRef.current?.currentTime ?? 0),
    [engine, streamViewer],
  );

  const activeVideo = streamViewer ? streamVideoRef : videoRef;
  const KindIcon = kind ? KIND_LABELS[kind].icon : Clapperboard;
  const connectedPeers = Object.values(peerStates).filter((s) => s === 'connected').length;

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={wrapperRef}
        className={isFullscreen ? 'dark flex h-full w-full flex-col justify-center gap-3 bg-black p-3 text-fg sm:p-6' : 'relative flex flex-col gap-3'}
      >
        <div className="relative">
          {!isFullscreen && <Ambilight videoRef={activeVideo} active={!!movie} />}
          <div
            className={`relative w-full overflow-hidden bg-black shadow-2xl shadow-black/60 ring-1 ring-white/10 ${
              isFullscreen ? 'h-[calc(100vh-9rem)] rounded-xl' : 'aspect-video rounded-2xl'
            }`}
          >
            <video ref={videoRef} className={`absolute inset-0 h-full w-full object-contain ${streamViewer ? 'hidden' : ''}`} playsInline />
            <video
              ref={streamVideoRef}
              className={`absolute inset-0 h-full w-full object-contain ${streamViewer ? '' : 'hidden'}`}
              playsInline
              autoPlay
              muted={streamMuted}
            />

            {/* Host clicks the screen to play/pause; double-click for full screen. */}
            <div
              className={`absolute inset-0 ${isHost && movie ? 'cursor-pointer' : ''}`}
              onClick={isHost && movie && !needsFile ? () => engine.togglePlay() : undefined}
              onDoubleClick={canFullscreen && movie ? toggleFullscreen : undefined}
              aria-hidden
            />

            <SubtitleOverlay cues={cues} getTime={subtitleTime} settings={subSettings} />

            {!movie && <Splash isHost={isHost} />}

            {needsFile && movie && (
              <OpenCopyPrompt
                name={movie.name}
                size={movie.size}
                position={engine.positionNow()}
                playing={state.isPlaying}
                streaming={movie.kind === 'stream'}
                onFile={(f) => void openCopy(f)}
              />
            )}

            {streamViewer && streamState !== 'connected' && (
              <div className="absolute inset-0 z-10 grid place-items-center bg-black/80 p-6 text-center text-white">
                {streamState === 'failed' ? (
                  <div className="flex max-w-sm flex-col items-center gap-3">
                    <AlertTriangle className="h-8 w-8 text-amber-400" aria-hidden />
                    <p className="font-semibold">Couldn't connect to {host?.name ?? 'the host'}'s stream</p>
                    <p className="text-sm text-white/70">Some networks block peer-to-peer video. Retry, or ask the host to use a link or “everyone has the file”.</p>
                    <button type="button" className="btn-ghost px-4 py-2 text-sm text-white" onClick={() => snapshot.hostId && streamViewerRef.current?.connect(snapshot.hostId)}>
                      <RefreshCw className="h-4 w-4" aria-hidden /> Retry
                    </button>
                  </div>
                ) : (
                  <p className="flex items-center gap-2 font-semibold">
                    <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                    {streamState === 'retrying' ? 'Reconnecting' : 'Connecting'} to {host?.name ?? 'the host'}'s stream…
                  </p>
                )}
              </div>
            )}

            {streamViewer && streamNeedsTap && (
              <TapOverlay
                label="Tap to start watching"
                onTap={() => void streamVideoRef.current?.play().then(() => setStreamNeedsTap(false)).catch(() => {})}
              />
            )}
            {!streamViewer && state.needsInteraction && movie && !needsFile && !state.error && (
              <TapOverlay label="Tap to join the movie" onTap={() => engine.unlock()} />
            )}

            <AnimatePresence>
              {state.catchingUp && movie && !streamViewer && (
                <motion.div
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="absolute left-3 top-3 z-10 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white"
                  role="status"
                >
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {isHost ? 'Buffering…' : 'Catching up…'}
                </motion.div>
              )}
            </AnimatePresence>

            {(mismatch || noPicture) && !needsFile && (
              <div className="absolute inset-x-3 top-3 z-10 flex items-start gap-2 rounded-xl bg-amber-500/90 px-3 py-2 text-xs font-medium text-black" role="status">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {noPicture ? 'Sound only: your browser can’t decode this video’s picture (HEVC/x265?). An MP4 (H.264) copy will work.' : mismatch}
              </div>
            )}

            {state.error && !streamViewer && movie && (
              <div className="absolute inset-0 z-10 grid place-items-center bg-black/85 p-6 text-center text-white" role="alert">
                <div className="flex max-w-sm flex-col items-center gap-2">
                  <AlertTriangle className="h-8 w-8 text-amber-400" aria-hidden />
                  <p className="font-semibold">{state.error}</p>
                </div>
              </div>
            )}

            <FloatingReactions items={reactions} />
          </div>
        </div>

        {streamViewer ? (
          <StreamBar
            engine={engine}
            duration={video?.durationSec ?? 0}
            hostName={host?.name ?? 'the host'}
            muted={streamMuted}
            onToggleMute={() => setStreamMuted((m) => !m)}
            isFullscreen={isFullscreen}
            onToggleFullscreen={canFullscreen ? toggleFullscreen : undefined}
          />
        ) : (
          <PlayerControls engine={engine} state={state} isHost={isHost} isFullscreen={isFullscreen} onToggleFullscreen={canFullscreen ? toggleFullscreen : undefined} />
        )}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          {movie ? (
            <>
              <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                <KindIcon className="h-3.5 w-3.5" aria-hidden /> {KIND_LABELS[movie.kind].text}
                {hostStreaming && <span className="normal-case tracking-normal text-muted">· {connectedPeers} watching your stream</span>}
              </p>
              <p className="truncate text-base font-bold" title={movie.name}>
                {movie.name}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">No movie yet</p>
          )}
        </div>
        <div className="flex items-center justify-center gap-2 sm:justify-end">
          {isHost && movie && (
            <button type="button" className="btn-ghost px-3 py-2 text-sm" onClick={() => setPickerOpen((o) => !o)}>
              <Clapperboard className="h-4 w-4" aria-hidden /> Change movie
            </button>
          )}
          <ReactionBar onReact={actions.sendReaction} />
        </div>
      </div>

      {isHost && (!movie || pickerOpen) && (
        <MovieSourcePicker
          onCancel={movie ? () => setPickerOpen(false) : undefined}
          onLoad={async (source) => {
            const err = await actions.loadMovie(source);
            if (!err) {
              setPickerOpen(false);
              setFileVersion((n) => n + 1);
            }
            return err;
          }}
        />
      )}

      {movie && (
        <div className="grid gap-3 lg:grid-cols-2">
          <ReadyCheck
            members={snapshot.members}
            ready={snapshot.movieReady}
            hostId={snapshot.hostId}
            selfId={selfId}
            isHost={isHost}
            playing={state.isPlaying}
          />
          <SubtitlePanel
            isHost={isHost}
            shared={sharedSubtitles}
            personal={personalSubs}
            onPersonal={setPersonalSubs}
            onShare={actions.shareSubtitles}
            settings={subSettings}
            onSettings={setSubSettings}
          />
        </div>
      )}
    </div>
  );
}

function Splash({ isHost }: { isHost: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(ellipse_at_50%_120%,#5b1d0a_0%,#160705_55%,#050202_100%)] p-6 text-center text-white">
      <div className="flex flex-col items-center gap-3">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-amber-500 to-red-600 shadow-xl shadow-red-600/30">
          <Clapperboard className="h-7 w-7" aria-hidden />
        </span>
        <p className="text-lg font-bold sm:text-2xl">Movie night 🍿</p>
        <p className="max-w-sm text-sm text-white/75">{isHost ? 'Pick the movie below. Friends will be asked to get ready.' : 'Waiting for the host to pick a movie.'}</p>
      </div>
    </div>
  );
}

interface OpenCopyPromptProps {
  name: string;
  size: number;
  position: number;
  playing: boolean;
  streaming: boolean;
  onFile: (file: File) => void;
}

function OpenCopyPrompt({ name, size, position, playing, streaming, onFile }: OpenCopyPromptProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-black/85 p-4 text-center text-white backdrop-blur-sm"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      }}
    >
      <div className="flex max-w-md flex-col items-center gap-3">
        <FolderOpen className="h-9 w-9 text-amber-400" aria-hidden />
        <p className="text-base font-bold sm:text-xl">{streaming ? 'Re-open the movie to keep streaming' : 'Open your copy to join'}</p>
        <p className="text-sm text-white/75">
          <span className="font-semibold text-white">{name}</span> · {formatBytes(size)}
          {playing && <> · the room is at {formatTime(position)}</>}
        </p>
        <button type="button" className="btn bg-gradient-to-r from-amber-500 to-red-600 px-5 py-2.5 text-sm text-white" onClick={() => inputRef.current?.click()}>
          <FolderOpen className="h-4 w-4" aria-hidden /> Choose file
        </button>
        <p className="hidden text-xs text-white/60 sm:block">…or drop it here. It plays from your device; nothing is uploaded.</p>
        <input
          ref={inputRef}
          type="file"
          accept={MOVIE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) onFile(file);
          }}
        />
      </div>
    </div>
  );
}

function TapOverlay({ label, onTap }: { label: string; onTap: () => void }) {
  return (
    <button
      type="button"
      onClick={onTap}
      className="absolute inset-0 z-20 grid place-items-center bg-black/60 text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-amber-400"
      autoFocus
    >
      <span className="flex flex-col items-center gap-3">
        <span className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-amber-500 to-red-600 shadow-xl">
          <Play className="h-7 w-7 translate-x-0.5 fill-white" aria-hidden />
        </span>
        <span className="text-lg font-bold">{label}</span>
      </span>
    </button>
  );
}

/**
 * The room's colours spill softly around the screen: the current frame is drawn into a tiny canvas
 * (a few times a second) and blurred up. Drawing a video into a canvas is allowed even for
 * cross-origin links, since we never read the pixels back.
 */
function Ambilight({ videoRef, active }: { videoRef: React.RefObject<HTMLVideoElement>; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!active) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const timer = setInterval(() => {
      const v = videoRef.current;
      if (v && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !document.hidden) {
        try {
          ctx.drawImage(v, 0, 0, 32, 18);
        } catch {
          /* frame not ready */
        }
      }
    }, 250);
    return () => clearInterval(timer);
  }, [videoRef, active]);
  return (
    <canvas
      ref={canvasRef}
      width={32}
      height={18}
      className={`pointer-events-none absolute -inset-6 -z-10 h-[calc(100%+3rem)] w-[calc(100%+3rem)] rounded-[3rem] blur-3xl saturate-150 transition-opacity duration-1000 ${
        active ? 'opacity-70' : 'opacity-0'
      }`}
      aria-hidden
    />
  );
}

interface StreamBarProps {
  engine: SyncEngine;
  duration: number;
  hostName: string;
  muted: boolean;
  onToggleMute: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: () => void;
}

/** Controls for people watching the host's live stream: there's nothing to seek, just watch. */
function StreamBar({ engine, duration, hostName, muted, onToggleMute, isFullscreen, onToggleFullscreen }: StreamBarProps) {
  const [position, setPosition] = useState(engine.positionNow());
  useEffect(() => {
    const t = setInterval(() => setPosition(engine.positionNow()), 500);
    return () => clearInterval(t);
  }, [engine]);
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className={`${isFullscreen ? 'rounded-xl bg-white/10 text-white' : 'glass rounded-2xl'} px-3 pb-2 pt-3 sm:px-4`}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/15">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-red-600" style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-md bg-red-600 px-2 py-1 text-xs font-bold text-white">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden /> LIVE
        </span>
        <span className="truncate text-sm text-muted">from {hostName}</span>
        <span className="ml-1 whitespace-nowrap text-xs tabular-nums text-muted sm:text-sm">
          {formatTime(position)} {duration > 0 && <>/ {formatTime(duration)}</>}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" className="icon-btn" onClick={onToggleMute} aria-label={muted ? 'Unmute' : 'Mute'}>
            {muted ? <VolumeX className="h-5 w-5" aria-hidden /> : <Volume2 className="h-5 w-5" aria-hidden />}
          </button>
          {onToggleFullscreen && (
            <button type="button" className="icon-btn" onClick={onToggleFullscreen} aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}>
              {isFullscreen ? <Minimize className="h-5 w-5" aria-hidden /> : <Maximize className="h-5 w-5" aria-hidden />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
