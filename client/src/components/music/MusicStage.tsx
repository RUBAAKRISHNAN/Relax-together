import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Disc3, Loader2, Music2, Play } from 'lucide-react';
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { MoodId, ReactionEmoji } from '@shared/constants';
import type { RoomSnapshot } from '@shared/types';
import type { FloatingReaction, RoomActions } from '../../hooks/useRoomSession';
import type { UploadJob } from '../../hooks/useUploads';
import { HybridPlayer } from '../../lib/hybridPlayer';
import { ORIGIN_LABELS, ORIGIN_STYLES, assetUrl, uploadedFileUrl } from '../../lib/media';
import type { EngineState, SyncEngine } from '../../lib/syncEngine';
import { PlayerState, loadYouTubeApi } from '../../lib/youtubeApi';
import { FloatingReactions } from '../FloatingReactions';
import { PlayerControls } from '../PlayerControls';
import { ReactionBar } from '../ReactionBar';
import { useToast } from '../Toasts';
import { MoodPicker } from './MoodPicker';
import { moodById } from './moods';
import { MusicAddBox } from './MusicAddBox';

interface MusicStageProps {
  engine: SyncEngine;
  state: EngineState;
  snapshot: RoomSnapshot;
  isHost: boolean;
  reactions: FloatingReaction[];
  actions: RoomActions;
  uploads: UploadJob[];
  onUpload: (files: File[]) => void;
  /** Filled in with a function returning the live music loudness, for the mood scene. */
  levelRef: MutableRefObject<() => number | null>;
  effects: boolean;
  onEffectsChange: (on: boolean) => void;
}

export function MusicStage({ engine, state, snapshot, isHost, reactions, actions, uploads, onUpload, levelRef, effects, onEffectsChange }: MusicStageProps) {
  const ytMountRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [source, setSource] = useState<'youtube' | 'audio'>('youtube');
  const [playerState, setPlayerState] = useState<number>(PlayerState.UNSTARTED);
  const [revealVideo, setRevealVideo] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const toast = useToast();
  const roomId = snapshot.roomId;
  const track = snapshot.video;
  const mood = moodById(snapshot.mood);

  // One hybrid player for the whole visit: YouTube for streamed songs, <audio> for uploads.
  useEffect(() => {
    const mount = ytMountRef.current!;
    const audio = audioRef.current!;
    let cancelled = false;
    let hybrid: HybridPlayer | null = null;
    let yt: YT.Player | null = null;
    const target = document.createElement('div');
    mount.appendChild(target);

    loadYouTubeApi()
      .then((api) => {
        if (cancelled) return;
        yt = new api.Player(target, {
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0, origin: window.location.origin },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              hybrid = new HybridPlayer(e.target, audio, (fileId) => uploadedFileUrl(roomId, fileId), {
                onStateChange: (s) => {
                  engine.onPlayerStateChange(s);
                  setPlayerState(s);
                },
                onError: (code) => engine.onPlayerError(code),
                onSourceChange: setSource,
              });
              levelRef.current = () => hybrid?.getLevel() ?? null;
              engine.attachPlayer(hybrid);
            },
            onStateChange: (e) => hybrid?.handleYouTubeState(e.data),
            onError: (e) => hybrid?.handleYouTubeError(e.data),
          },
        });
      })
      .catch((err: Error) => !cancelled && setApiError(err.message));

    return () => {
      cancelled = true;
      levelRef.current = () => null;
      engine.detachPlayer();
      hybrid?.destroy();
      try {
        yt?.destroy();
      } catch {
        /* already gone */
      }
      mount.innerHTML = '';
    };
  }, [engine, roomId, levelRef]);

  // Warm the cache for the next uploaded song so it starts instantly.
  const nextUpload = snapshot.queue.find((q) => q.video.videoId.startsWith('file:'))?.video.videoId;
  useEffect(() => {
    if (!nextUpload) return;
    const preload = new Audio();
    preload.preload = 'auto';
    preload.crossOrigin = 'anonymous';
    preload.src = uploadedFileUrl(roomId, nextUpload.slice(5));
    return () => preload.removeAttribute('src');
  }, [nextUpload, roomId]);

  // YouTube paints its own title bar, spinner and "More videos" panel while a video starts or
  // pauses. Keep the cover art on top until it has been playing for a moment.
  const ytPlaying = source === 'youtube' && playerState === PlayerState.PLAYING;
  useEffect(() => {
    if (!ytPlaying) {
      setRevealVideo(false);
      return;
    }
    const t = setTimeout(() => setRevealVideo(true), 2000);
    return () => clearTimeout(t);
  }, [ytPlaying, track?.videoId]);

  const error = apiError ?? state.error;
  const playing = state.isPlaying && !!track;
  const showVideo = !!track && source === 'youtube';
  const cover = track ? assetUrl(track.thumbnail) : '';
  const canSkip = isHost && snapshot.queue.some((q) => q.status !== 'failed');

  const skip = async () => {
    const err = await actions.queueNext();
    if (err) toast(err, 'error');
  };

  return (
    <div className="relative flex flex-col items-center gap-4 sm:gap-5">
      <div className="relative w-full max-w-[min(100%,26rem)] pt-2 sm:pt-4">
        {/* The record peeking out from behind the sleeve; it spins while music plays. */}
        <motion.div
          className="absolute right-[-14%] top-[10%] hidden aspect-square w-[78%] sm:block"
          animate={{ x: track ? 0 : -40, opacity: track ? 1 : 0 }}
          transition={{ duration: 0.6 }}
          aria-hidden
        >
          {/* A CSS animation spins on the compositor, so it costs the main thread nothing. */}
          <div
            className="h-full w-full rounded-full"
            style={{
              background: `repeating-radial-gradient(circle at center, #111 0 2px, #1d1d1f 2px 4px)`,
              boxShadow: `0 20px 50px -10px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)`,
              animation: 'spin 4s linear infinite',
              animationPlayState: playing ? 'running' : 'paused',
            }}
          >
            <div className="absolute inset-[34%] overflow-hidden rounded-full" style={{ background: mood.accent }}>
              {cover && <img src={cover} alt="" className="h-full w-full object-cover opacity-90" />}
            </div>
            <div className="absolute inset-[48%] rounded-full bg-black/80" />
          </div>
        </motion.div>

        {/* Sleeve / artwork */}
        <motion.div
          className="relative aspect-square w-[82%] overflow-hidden rounded-3xl bg-black/40 ring-1 ring-white/15 sm:w-[78%]"
          style={{ boxShadow: `0 30px 70px -20px rgba(0,0,0,0.7), 0 0 70px -10px ${mood.accent}66` }}
          animate={{ scale: playing ? 1 : 0.97 }}
          transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        >
          {/* YouTube player stays mounted; for streamed songs it is the artwork (cropped to a square). */}
          <div className={`absolute inset-0 overflow-hidden ${showVideo ? '' : 'invisible'}`}>
            <div ref={ytMountRef} className="yt-mount absolute inset-y-0 left-1/2 w-[177.8%] -translate-x-1/2" />
          </div>
          {track && (!showVideo || !revealVideo) && (
            cover ? (
              <img src={cover} alt={`Cover art for ${track.title}`} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <div className="absolute inset-0 grid place-items-center" style={{ background: mood.background }}>
                <Music2 className="h-20 w-20 text-white/80 drop-shadow-lg" aria-hidden />
              </div>
            )
          )}
          {!track && !error && (
            <div className="absolute inset-0 grid place-items-center p-6 text-center text-white" style={{ background: mood.background }}>
              <div className="flex flex-col items-center gap-3 [text-shadow:0_1px_8px_rgba(0,0,0,0.45)]">
                <motion.span animate={{ rotate: 360 }} transition={{ duration: 8, repeat: Infinity, ease: 'linear' }}>
                  <Disc3 className="h-14 w-14 drop-shadow-lg" aria-hidden />
                </motion.span>
                <p className="text-lg font-bold">{isHost ? 'Start the music 🎵' : 'Waiting for the first song 🎵'}</p>
                <p className="text-sm text-white/85">Search a song, paste a link from any music app, or upload your own.</p>
              </div>
            </div>
          )}

          {/* Interaction shield: the YouTube iframe is display only. Host click = play/pause. */}
          <div
            className={`absolute inset-0 ${isHost && track ? 'cursor-pointer' : ''}`}
            onClick={isHost && track ? () => engine.togglePlay() : undefined}
            aria-hidden
          />

          <AnimatePresence>
            {state.catchingUp && track && (
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white"
                role="status"
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> {isHost ? 'Buffering…' : 'Catching up…'}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {state.needsInteraction && track && !error && (
              <motion.button
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => engine.unlock()}
                className="absolute inset-0 z-20 grid place-items-center bg-black/60 text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-fuchsia-400"
                autoFocus
              >
                <span className="flex flex-col items-center gap-3">
                  <motion.span
                    animate={{ scale: [1, 1.08, 1] }}
                    transition={{ duration: 1.6, repeat: Infinity }}
                    className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-pink-500 shadow-xl"
                  >
                    <Play className="h-7 w-7 translate-x-0.5 fill-white" aria-hidden />
                  </motion.span>
                  <span className="text-lg font-bold">Tap to join the music</span>
                </span>
              </motion.button>
            )}
          </AnimatePresence>

          {error && (
            <div className="absolute inset-0 z-10 grid place-items-center bg-black/80 p-6 text-center text-white" role="alert">
              <div className="flex flex-col items-center gap-2">
                <AlertTriangle className="h-8 w-8 text-amber-400" aria-hidden />
                <p className="font-semibold">{error}</p>
                <p className="text-sm text-white/70">{isHost ? 'Skip to another song.' : 'Waiting for the host to pick another song.'}</p>
              </div>
            </div>
          )}
        </motion.div>
        <audio ref={audioRef} className="hidden" />
      </div>

      {/* Title / artist, on glass so they stay readable over bright scenes like Cherry Blossom */}
      <div className="glass w-full max-w-xl rounded-2xl px-4 py-3 text-center">
        <AnimatePresence mode="wait" initial={false}>
          {track ? (
            <motion.div key={track.videoId} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <h2 className="line-clamp-2 text-xl font-extrabold tracking-tight sm:text-2xl" title={track.title}>
                {track.title}
              </h2>
              <p className="mt-1 flex flex-wrap items-center justify-center gap-2 text-sm text-muted">
                {track.author && <span className="font-medium text-fg/80">{track.author}</span>}
                {track.album && <span>· {track.album}</span>}
                {track.origin && (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${ORIGIN_STYLES[track.origin]}`}>
                    {track.origin === 'upload' ? 'Uploaded' : `via ${ORIGIN_LABELS[track.origin]}`}
                  </span>
                )}
              </p>
            </motion.div>
          ) : (
            <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-sm text-muted">
              Nothing playing yet
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      <div className="w-full max-w-xl">
        <PlayerControls engine={engine} state={state} isHost={isHost} isFullscreen={false} onSkip={canSkip ? skip : undefined} />
      </div>

      {!track && (
        <div className="glass w-full max-w-xl rounded-2xl p-3 sm:p-4">
          <MusicAddBox
            isHost={isHost}
            hasTrack={false}
            onPlay={actions.loadVideo}
            onQueue={actions.queueAdd}
            onUpload={onUpload}
            uploads={uploads}
            autoFocus={isHost}
          />
        </div>
      )}

      <ReactionBar onReact={(e: ReactionEmoji) => actions.sendReaction(e)} />

      <div className="w-full max-w-xl">
        <MoodPicker
          mood={snapshot.mood}
          canChange={isHost}
          effects={effects}
          onEffectsChange={onEffectsChange}
          onChange={async (m: MoodId) => {
            const err = await actions.setMood(m);
            if (err) toast(err, 'error');
          }}
        />
      </div>

      <FloatingReactions items={reactions} />
    </div>
  );
}
