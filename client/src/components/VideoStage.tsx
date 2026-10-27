import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, Film, Loader2, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useImmersive } from '../hooks/useImmersive';
import type { FloatingReaction } from '../hooks/useRoomSession';
import type { EngineState, SyncEngine } from '../lib/syncEngine';
import { loadYouTubeApi } from '../lib/youtubeApi';
import { FloatingReactions } from './FloatingReactions';
import { PlayerControls } from './PlayerControls';

interface VideoStageProps {
  engine: SyncEngine;
  state: EngineState;
  isHost: boolean;
  reactions: FloatingReaction[];
}

export function VideoStage({ engine, state, isHost, reactions }: VideoStageProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const immersive = useImmersive(wrapperRef, state.isPlaying);
  const isFullscreen = immersive.active;
  /** Whether the controls were hidden when this tap started (then the tap only reveals them). */
  const tapRevealed = useRef(false);

  // Create the YouTube player once; the engine drives it from then on.
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;
    let cancelled = false;
    let player: YT.Player | null = null;
    const target = document.createElement('div');
    container.appendChild(target);

    loadYouTubeApi()
      .then((api) => {
        if (cancelled) return;
        player = new api.Player(target, {
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0, // our own controls; the shield below blocks direct iframe input
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: (e) => !cancelled && engine.attachPlayer(e.target),
            onStateChange: (e) => !cancelled && engine.onPlayerStateChange(e.data),
            onError: (e) => !cancelled && engine.onPlayerError(e.data),
          },
        });
      })
      .catch((err: Error) => !cancelled && setApiError(err.message));

    return () => {
      cancelled = true;
      engine.detachPlayer();
      try {
        player?.destroy();
      } catch {
        /* iframe already gone */
      }
      container.innerHTML = '';
    };
  }, [engine]);

  const hasVideo = !!state.videoId;
  const error = apiError ?? state.error;
  const showSkeleton = hasVideo && !state.playerReady && !error;

  return (
    <div
      ref={wrapperRef}
      // `dark` forces dark tokens in full screen, where the backdrop is always black.
      className={
        isFullscreen
          ? `dark overflow-hidden bg-black text-fg ${immersive.pseudo ? 'fixed inset-0 z-[100]' : 'relative h-full w-full'} ${
              immersive.controlsVisible ? '' : 'cursor-none'
            }`
          : 'flex flex-col gap-3'
      }
    >
      <div
        className={
          isFullscreen
            ? 'absolute inset-0 overflow-hidden bg-black'
            : 'relative aspect-video w-full overflow-hidden rounded-2xl bg-black shadow-2xl shadow-black/40 ring-1 ring-line/10'
        }
      >
        <div ref={mountRef} className={`yt-mount absolute inset-0 ${hasVideo ? '' : 'invisible'}`} />

        {/* Interaction shield: viewers can't touch the iframe; host click = play/pause.
            In full screen, a tap while the controls are hidden only brings them back. */}
        <div
          className={`absolute inset-0 ${isHost && hasVideo ? 'cursor-pointer' : ''}`}
          onPointerDownCapture={() => (tapRevealed.current = isFullscreen && !immersive.visibleRef.current)}
          onClick={() => !tapRevealed.current && isHost && hasVideo && engine.togglePlay()}
          onDoubleClick={hasVideo ? immersive.toggle : undefined}
          aria-hidden
        />

        {!hasVideo && !error && <EmptyStage isHost={isHost} />}
        {showSkeleton && <div className="skeleton absolute inset-0 rounded-none" aria-label="Loading player" />}

        <AnimatePresence>
          {state.catchingUp && hasVideo && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold text-white backdrop-blur"
              role="status"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              {isHost ? 'Buffering…' : 'Catching up…'}
            </motion.div>
          )}
        </AnimatePresence>

        <FloatingReactions items={reactions} />

        <AnimatePresence>
          {state.needsInteraction && hasVideo && !error && (
            <motion.button
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => engine.unlock()}
              className="absolute inset-0 z-20 grid place-items-center bg-black/65 p-4 text-center text-white backdrop-blur-sm focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-fuchsia-400"
              autoFocus
            >
              <div className="flex flex-col items-center gap-3">
                <motion.span
                  animate={{ scale: [1, 1.08, 1] }}
                  transition={{ duration: 1.6, repeat: Infinity }}
                  className="grid h-16 w-16 place-items-center rounded-full bg-gradient-to-br from-violet-500 to-pink-500 shadow-xl shadow-fuchsia-500/40 sm:h-20 sm:w-20"
                >
                  <Play className="h-7 w-7 translate-x-0.5 fill-white sm:h-9 sm:w-9" aria-hidden />
                </motion.span>
                <span className="text-lg font-bold sm:text-2xl">Tap to join playback</span>
                <span className="hidden max-w-xs text-sm text-white/75 sm:block">
                  Your browser blocked autoplay. One tap and you'll be in sync with everyone.
                </span>
              </div>
            </motion.button>
          )}
        </AnimatePresence>

        {error && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-black/80 p-6 text-center text-white" role="alert">
            <div className="flex max-w-sm flex-col items-center gap-2">
              <AlertTriangle className="h-8 w-8 text-amber-400" aria-hidden />
              <p className="font-semibold">{error}</p>
              <p className="text-sm text-white/70">
                {isHost ? 'Try a different link.' : 'Waiting for the host to pick another video.'}
              </p>
            </div>
          </div>
        )}
      </div>

      <FullscreenBar active={isFullscreen} visible={immersive.controlsVisible}>
        <PlayerControls engine={engine} state={state} isHost={isHost} isFullscreen={isFullscreen} onToggleFullscreen={immersive.toggle} />
      </FullscreenBar>
    </div>
  );
}

function EmptyStage({ isHost }: { isHost: boolean }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-hidden bg-gradient-to-br from-violet-950 via-[#14102b] to-fuchsia-950 p-6 text-center">
      <motion.div
        className="absolute h-64 w-64 rounded-full bg-fuchsia-500/20 blur-3xl"
        animate={{ scale: [1, 1.2, 1], opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 6, repeat: Infinity }}
        aria-hidden
      />
      <div className="relative flex flex-col items-center gap-3 text-white">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/15 sm:h-16 sm:w-16">
          <Film className="h-6 w-6 sm:h-8 sm:w-8" aria-hidden />
        </span>
        <p className="text-base font-bold sm:text-2xl">
          {isHost ? 'Paste a YouTube link to start the party 🎬' : 'Waiting for the host to pick a video 🎬'}
        </p>
        <p className="hidden text-sm text-white/70 sm:block">
          {isHost ? 'Use the box below the player. Everyone will see it instantly.' : 'Got an idea? Suggest one in the Queue tab.'}
        </p>
      </div>
    </div>
  );
}

/** In full screen, the controls float over the picture and fade away while you watch. */
export function FullscreenBar({ active, visible, children }: { active: boolean; visible: boolean; children: React.ReactNode }) {
  if (!active) return <>{children}</>;
  return (
    <div
      className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/90 via-black/55 to-transparent pb-[max(env(safe-area-inset-bottom),0.25rem)] pt-14 transition-opacity duration-300 ${
        visible ? 'opacity-100' : 'pointer-events-none opacity-0'
      }`}
    >
      {children}
    </div>
  );
}
