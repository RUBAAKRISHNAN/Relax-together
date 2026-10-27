import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Clapperboard, FolderOpen, Link2, Loader2, Maximize, Minimize, Play, Radio, RefreshCw, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MovieReadyState, RoomSnapshot, SubtitleTrack } from '@shared/types';
import { useImmersive } from '../../hooks/useImmersive';
import type { FloatingReaction, RoomActions } from '../../hooks/useRoomSession';
import { type AudioTrackInfo, type FileAudioTracks, readFileAudioTracks } from '../../lib/audioTracks';
import { fingerprintFile, formatBytes } from '../../lib/fingerprint';
import { formatTime } from '../../lib/format';
import { RelayHost, RelayViewer, type RelayViewerState } from '../../lib/movieRelay';
import { StreamHost, StreamViewer, type ViewerState, captureVideo } from '../../lib/movieStream';
import type { AppSocket } from '../../lib/socket';
import { parseSubtitles } from '../../lib/subtitles';
import type { EngineState, SyncEngine } from '../../lib/syncEngine';
import { VideoElementPlayer, type VideoSource } from '../../lib/videoElementPlayer';
import { FloatingReactions } from '../FloatingReactions';
import { AudioMenu, type AudioMenuProps, PlayerControls } from '../PlayerControls';
import { ReactionBar } from '../ReactionBar';
import { useToast } from '../Toasts';
import { FullscreenBar } from '../VideoStage';
import { MOVIE_ACCEPT, localCopy, rememberFile, rememberFileForMovie, setAudioVariant } from './localFiles';
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

/** How long to try a direct (peer-to-peer) connection before switching to the server relay. */
const P2P_TIMEOUT_MS = 8000;

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
  // Audio languages: from the file's header (own copies) or from the player (HLS links, Safari).
  const [fileAudio, setFileAudio] = useState<FileAudioTracks | null>(null);
  const [audioChoice, setAudioChoice] = useState<string | null>(null);
  const [playerAudio, setPlayerAudio] = useState<{ tracks: AudioTrackInfo[]; current: string | null } | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [streamState, setStreamState] = useState<ViewerState>('waiting');
  const [streamNeedsTap, setStreamNeedsTap] = useState(false);
  // Peer-to-peer first; if it can't connect (carrier-grade NAT), the stream comes via the server.
  const [useRelay, setUseRelay] = useState(false);
  const [relayState, setRelayState] = useState<RelayViewerState>('waiting');
  const [streamAttempt, setStreamAttempt] = useState(0);
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
      onAudioTracks: (tracks, current) => setPlayerAudio(tracks.length ? { tracks, current } : null),
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
    if (kind === 'stream' && !isHost) {
      if (streamState === 'connected' || relayState === 'playing') ready = 'ready';
      else ready = relayState === 'unsupported' ? 'error' : 'missing';
    }
    else if (state.error) ready = 'error';
    else if (kind === 'url') ready = 'ready';
    else ready = !local ? 'missing' : mismatch ? 'mismatch' : 'ready';
    const key = `${videoId}:${ready}`;
    if (reported.current === key) return;
    reported.current = key;
    actions.reportMovieReady(videoId, ready);
  }, [videoId, kind, isHost, streamState, relayState, state.error, local, mismatch, actions]);

  // ---------------------------------------------------------------- streaming (host)

  const streamHostRef = useRef<StreamHost | null>(null);
  const hostStreaming = kind === 'stream' && isHost && !!local;
  useEffect(() => {
    if (!hostStreaming) return;
    const el = videoRef.current!;
    const host = new StreamHost(socket, setPeerStates, el);
    const relay = new RelayHost(socket, el);
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
      stream.onaddtrack = () => {
        const tracks = new MediaStream(stream.getTracks());
        host.setStream(tracks);
        relay.setStream(tracks);
      };
      host.setStream(stream);
      relay.setStream(stream);
    };
    if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) capture();
    el.addEventListener('loadeddata', capture);
    return () => {
      el.removeEventListener('loadeddata', capture);
      host.stop();
      relay.stop();
      streamHostRef.current = null;
      setPeerStates({});
    };
  }, [hostStreaming, socket, toast, videoId]);

  const viewerIds = snapshot.members.filter((m) => m.online && m.id !== selfId).map((m) => m.id).join(',');
  useEffect(() => {
    streamHostRef.current?.setViewers(viewerIds ? viewerIds.split(',') : []);
  }, [viewerIds, hostStreaming]);

  // ---------------------------------------------------------------- streaming (viewer)

  // Each movie, host or manual retry starts over with peer-to-peer.
  useEffect(() => {
    setUseRelay(false);
    setRelayState('waiting');
  }, [videoId, snapshot.hostId, streamAttempt]);

  const streamViewerRef = useRef<StreamViewer | null>(null);
  useEffect(() => {
    if (!streamViewer || !snapshot.hostId || useRelay) return;
    let connected = false;
    const viewer = new StreamViewer(socket, setRemoteStream, (s) => {
      setStreamState(s);
      if (s === 'connected') connected = true;
      // Direct connection impossible on this network: go through the server instead.
      if (s === 'failed' && !connected) setUseRelay(true);
    });
    streamViewerRef.current = viewer;
    viewer.connect(snapshot.hostId);
    const fallback = setTimeout(() => !connected && setUseRelay(true), P2P_TIMEOUT_MS);
    return () => {
      clearTimeout(fallback);
      viewer.stop();
      streamViewerRef.current = null;
      setRemoteStream(null);
      setStreamState('waiting');
    };
  }, [streamViewer, snapshot.hostId, socket, videoId, useRelay, streamAttempt]);

  useEffect(() => {
    const el = streamVideoRef.current;
    if (!streamViewer || !useRelay || !el) return;
    const relay = new RelayViewer(socket, el, setRelayState, () => setStreamNeedsTap(true));
    relay.start();
    return () => relay.stop();
  }, [streamViewer, useRelay, socket, videoId]);

  useEffect(() => {
    const el = streamVideoRef.current;
    if (!el || useRelay) return;
    el.srcObject = remoteStream;
    if (remoteStream) void el.play().then(() => setStreamNeedsTap(false)).catch(() => setStreamNeedsTap(true));
  }, [remoteStream, useRelay]);

  // ---------------------------------------------------------------- audio language

  // Own copies: read the file's audio tracks once it's open on this device.
  const localFile = local?.file ?? null;
  useEffect(() => {
    setFileAudio(null);
    setAudioChoice(null);
    setPlayerAudio(null);
    if (!localFile || streamViewer) return;
    let cancelled = false;
    void readFileAudioTracks(localFile).then((info) => {
      if (cancelled || !info) return;
      setFileAudio(info);
      setAudioChoice(info.defaultId);
    });
    return () => {
      cancelled = true;
    };
  }, [localFile, streamViewer, videoId]);

  /** Switch language for this person only; playback resumes in sync at the room's position. */
  const chooseAudio = (id: string) => {
    if (fileAudio && videoId) {
      setAudioVariant(videoId, fileAudio.withAudio(id));
      setAudioChoice(id);
      setFileVersion((n) => n + 1);
      engine.reload();
    } else {
      playerRef.current?.setAudioTrack(id);
    }
  };

  const audioMenu: AudioMenuProps | undefined = fileAudio
    ? { tracks: fileAudio.tracks, current: audioChoice, onChange: chooseAudio }
    : playerAudio
      ? { ...playerAudio, onChange: chooseAudio }
      : movie
        ? // Nothing to choose from (one audio track, or a format we can't read): still say what's playing.
          { tracks: [{ id: 'original', label: 'Original audio' }], current: 'original', onChange: () => {} }
        : undefined;

  // ---------------------------------------------------------------- fullscreen + subtitles

  const immersive = useImmersive(wrapperRef, streamViewer || state.isPlaying);
  const isFullscreen = immersive.active;
  /** Whether the controls were hidden when this tap started (then the tap only reveals them). */
  const tapRevealed = useRef(false);

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
        // `dark` forces dark tokens in full screen, where the backdrop is always black.
        className={
          isFullscreen
            ? `dark overflow-hidden bg-black text-fg ${immersive.pseudo ? 'fixed inset-0 z-[100]' : 'relative h-full w-full'} ${
                immersive.controlsVisible ? '' : 'cursor-none'
              }`
            : 'relative flex flex-col gap-3'
        }
      >
        <div className={isFullscreen ? 'absolute inset-0' : 'relative'}>
          {!isFullscreen && <Ambilight videoRef={activeVideo} active={!!movie} />}
          <div
            className={
              isFullscreen
                ? 'absolute inset-0 overflow-hidden bg-black'
                : 'relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/60 ring-1 ring-white/10'
            }
          >
            <video ref={videoRef} className={`absolute inset-0 h-full w-full object-contain ${streamViewer ? 'hidden' : ''}`} playsInline />
            <video
              ref={streamVideoRef}
              className={`absolute inset-0 h-full w-full object-contain ${streamViewer ? '' : 'hidden'}`}
              playsInline
              autoPlay
              muted={streamMuted}
            />

            {/* Host clicks the screen to play/pause; double-click for full screen. In full screen, a tap
                while the controls are hidden only brings them back. */}
            <div
              className={`absolute inset-0 ${isHost && movie ? 'cursor-pointer' : ''}`}
              onPointerDownCapture={() => (tapRevealed.current = isFullscreen && !immersive.visibleRef.current)}
              onClick={() => !tapRevealed.current && isHost && movie && !needsFile && engine.togglePlay()}
              onDoubleClick={movie ? immersive.toggle : undefined}
              aria-hidden
            />

            {isFullscreen && movie && (
              <div
                className={`pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/80 to-transparent px-4 pb-10 pt-[max(env(safe-area-inset-top),0.75rem)] transition-opacity duration-300 ${
                  immersive.controlsVisible ? 'opacity-100' : 'opacity-0'
                }`}
              >
                <p className="truncate text-sm font-semibold text-white sm:text-base">{movie.name}</p>
              </div>
            )}

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

            {streamViewer && streamState !== 'connected' && relayState !== 'playing' && (
              <div className="absolute inset-0 z-10 grid place-items-center bg-black/80 p-6 text-center text-white">
                {relayState === 'unsupported' ? (
                  <div className="flex max-w-sm flex-col items-center gap-3">
                    <AlertTriangle className="h-8 w-8 text-amber-400" aria-hidden />
                    <p className="font-semibold">This browser can't play the relayed stream</p>
                    <p className="text-sm text-white/70">Open the room in Chrome, Edge or Firefox, or ask the host to use a link or “everyone has the file”.</p>
                  </div>
                ) : (
                  <div className="flex max-w-sm flex-col items-center gap-3">
                    <p className="flex items-center gap-2 font-semibold">
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                      {useRelay
                        ? `Streaming ${host?.name ?? 'the host'}'s movie through the server…`
                        : `${streamState === 'retrying' ? 'Reconnecting' : 'Connecting'} to ${host?.name ?? 'the host'}'s stream…`}
                    </p>
                    {useRelay && <p className="text-sm text-white/70">A direct connection isn't possible on this network, so the movie is coming via our server.</p>}
                    <button type="button" className="btn-ghost px-4 py-2 text-sm text-white" onClick={() => setStreamAttempt((n) => n + 1)}>
                      <RefreshCw className="h-4 w-4" aria-hidden /> Retry
                    </button>
                  </div>
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

        <FullscreenBar active={isFullscreen} visible={immersive.controlsVisible}>
          {streamViewer ? (
            <StreamBar
              engine={engine}
              duration={video?.durationSec ?? 0}
              hostName={host?.name ?? 'the host'}
              relayed={useRelay}
              muted={streamMuted}
              onToggleMute={() => setStreamMuted((m) => !m)}
              isFullscreen={isFullscreen}
              onToggleFullscreen={immersive.toggle}
            />
          ) : (
            <PlayerControls
              engine={engine}
              state={state}
              isHost={isHost}
              isFullscreen={isFullscreen}
              onToggleFullscreen={immersive.toggle}
              audio={audioMenu}
            />
          )}
        </FullscreenBar>
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
/**
 * Phones and low-power devices skip the glow: there the GPU time is better spent on the movie.
 * (It's barely visible on a phone-width screen anyway.)
 */
const glowSupported =
  typeof window !== 'undefined' &&
  !window.matchMedia('(pointer: coarse)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches &&
  (navigator.hardwareConcurrency ?? 8) > 4;

/**
 * The movie's colours glowing around the screen. Kept cheap: a 6×4 canvas the browser stretches
 * smoothly (already soft, so no CSS blur filter to redraw) with edges faded by a mask, updated
 * twice a second.
 */
function Ambilight({ videoRef, active }: { videoRef: React.RefObject<HTMLVideoElement>; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const on = active && glowSupported;
  useEffect(() => {
    if (!on) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const timer = setInterval(() => {
      const v = videoRef.current;
      if (v && !v.paused && v.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !document.hidden) {
        try {
          ctx.drawImage(v, 0, 0, 6, 4);
        } catch {
          /* frame not ready */
        }
      }
    }, 500);
    return () => clearInterval(timer);
  }, [videoRef, on]);
  if (!glowSupported) return null;
  return (
    <canvas
      ref={canvasRef}
      width={6}
      height={4}
      className={`pointer-events-none absolute -inset-10 -z-10 h-[calc(100%+5rem)] w-[calc(100%+5rem)] transition-opacity duration-1000 [mask-image:radial-gradient(closest-side,#000_55%,transparent)] ${
        on ? 'opacity-60' : 'opacity-0'
      }`}
      aria-hidden
    />
  );
}

interface StreamBarProps {
  engine: SyncEngine;
  /** Coming through the server relay rather than peer-to-peer. */
  relayed: boolean;
  duration: number;
  hostName: string;
  muted: boolean;
  onToggleMute: () => void;
  isFullscreen: boolean;
  onToggleFullscreen?: () => void;
}

const HOST_AUDIO: AudioMenuProps = {
  tracks: [{ id: 'host', label: "Host's audio" }],
  current: 'host',
  onChange: () => {},
  note: 'A live stream carries the audio the host is playing.',
};

/** Controls for people watching the host's live stream: there's nothing to seek, just watch. */
function StreamBar({ engine, relayed, duration, hostName, muted, onToggleMute, isFullscreen, onToggleFullscreen }: StreamBarProps) {
  const [position, setPosition] = useState(engine.positionNow());
  useEffect(() => {
    const t = setInterval(() => setPosition(engine.positionNow()), 500);
    return () => clearInterval(t);
  }, [engine]);
  const progress = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  return (
    <div className={`${isFullscreen ? 'text-white' : 'glass rounded-2xl'} px-3 pb-2 pt-3 sm:px-4`}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/15">
        <div className="h-full rounded-full bg-gradient-to-r from-amber-500 to-red-600" style={{ width: `${progress}%` }} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-md bg-red-600 px-2 py-1 text-xs font-bold text-white">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" aria-hidden /> LIVE
        </span>
        <span className="truncate text-sm text-muted">
          from {hostName}
          {relayed && <span title="A direct connection wasn't possible on this network"> · via server</span>}
        </span>
        <span className="ml-1 whitespace-nowrap text-xs tabular-nums text-muted sm:text-sm">
          {formatTime(position)} {duration > 0 && <>/ {formatTime(duration)}</>}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <AudioMenu {...HOST_AUDIO} />
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
