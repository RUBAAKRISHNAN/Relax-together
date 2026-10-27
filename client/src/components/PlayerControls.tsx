import { AnimatePresence, motion } from 'framer-motion';
import { Check, Languages, Lock, Maximize, Minimize, Pause, Play, RotateCcw, RotateCw, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { AudioTrackInfo } from '../lib/audioTracks';
import { formatTime } from '../lib/format';
import type { EngineState, SyncEngine } from '../lib/syncEngine';

interface PlayerControlsProps {
  engine: SyncEngine;
  state: EngineState;
  isHost: boolean;
  isFullscreen: boolean;
  onToggleFullscreen?: () => void;
  /** Host only: jump to the next song in the queue. */
  onSkip?: () => void;
  /** Audio languages this person can choose between (movies with several audio tracks). */
  audio?: AudioMenuProps;
}

export interface AudioMenuProps {
  tracks: AudioTrackInfo[];
  current: string | null;
  onChange: (id: string) => void;
  busy?: boolean;
}

export function PlayerControls({ engine, state, isHost, isFullscreen, onToggleFullscreen, onSkip, audio }: PlayerControlsProps) {
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubRef = useRef<number | null>(null);

  const duration = state.duration;
  const time = Math.min(scrub ?? state.currentTime, duration || Infinity);
  const progress = duration > 0 ? (time / duration) * 100 : 0;
  const ready = state.playerReady && !!state.videoId;
  const volume = state.muted ? 0 : state.volume;
  const VolumeIcon = volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  const commitScrub = () => {
    if (scrubRef.current !== null) engine.seek(scrubRef.current);
    scrubRef.current = null;
    setScrub(null);
  };

  const live = state.isLive;
  const atLiveEdge = live && (state.liveBehind ?? 0) === 0;

  return (
    // In full screen the bar floats over the picture; the stage provides the fade-out gradient.
    <div className={`${isFullscreen ? 'text-white' : 'glass rounded-2xl'} px-3 pb-2 pt-3 sm:px-4`}>
      {live ? (
        // Live streams have no meaningful duration, so the bar just shows "live" vs "behind".
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/15" aria-hidden>
          <div className={`h-full rounded-full ${atLiveEdge ? 'w-full bg-red-500' : 'w-[85%] bg-red-500/50'}`} />
        </div>
      ) : isHost ? (
        <input
          type="range"
          className="range block w-full"
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          disabled={!ready || !duration}
          style={{ '--progress': `${progress}%` } as CSSProperties}
          onChange={(e) => {
            scrubRef.current = Number(e.target.value);
            setScrub(scrubRef.current);
          }}
          onPointerUp={commitScrub}
          onKeyUp={commitScrub}
          onBlur={commitScrub}
          aria-label="Seek"
          aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
        />
      ) : (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-line/15"
          role="progressbar"
          aria-label="Playback position"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={`${formatTime(time)} of ${formatTime(duration)}`}
        >
          <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500 transition-[width] duration-200" style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className="mt-2 flex items-center gap-1 sm:gap-2">
        {isHost ? (
          <>
            <button type="button" className="icon-btn" onClick={() => engine.seekBy(-10)} disabled={!ready} aria-label="Back 10 seconds" title="Back 10s (←)">
              <RotateCcw className="h-5 w-5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={() => engine.togglePlay()}
              disabled={!ready}
              className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-pink-600 text-white shadow-lg shadow-fuchsia-600/30 transition hover:brightness-110 active:scale-95 disabled:opacity-40"
              aria-label={state.isPlaying ? 'Pause' : 'Play'}
              title={state.isPlaying ? 'Pause (Space)' : 'Play (Space)'}
            >
              {state.isPlaying ? <Pause className="h-5 w-5 fill-white" aria-hidden /> : <Play className="h-5 w-5 translate-x-px fill-white" aria-hidden />}
            </button>
            <button type="button" className="icon-btn" onClick={() => engine.seekBy(10)} disabled={!ready} aria-label="Forward 10 seconds" title="Forward 10s (→)">
              <RotateCw className="h-5 w-5" aria-hidden />
            </button>
            {onSkip && (
              <button type="button" className="icon-btn" onClick={onSkip} aria-label="Next song" title="Next in queue">
                <SkipForward className="h-5 w-5" aria-hidden />
              </button>
            )}
          </>
        ) : (
          <div className="flex min-w-0 items-center gap-2 text-sm text-muted" title="Only the host can play, pause or seek">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-line/5">
              <Lock className="h-4 w-4" aria-hidden />
            </span>
            <span className="truncate">
              Host controls<span className="hidden sm:inline"> playback</span>
            </span>
          </div>
        )}

        {live ? (
          <LiveBadge atEdge={atLiveEdge} behind={state.liveBehind} onGoLive={isHost ? () => engine.goLive() : undefined} />
        ) : (
          <span className="ml-1 whitespace-nowrap text-xs tabular-nums text-muted sm:text-sm">
            {formatTime(time)} <span className="opacity-60">/</span> {formatTime(duration)}
          </span>
        )}

        <div className="ml-auto flex items-center gap-0.5">
          {audio && audio.tracks.length > 1 && <AudioMenu {...audio} />}
          <button type="button" className="icon-btn" onClick={() => engine.toggleMute()} disabled={!state.playerReady} aria-label={volume === 0 ? 'Unmute' : 'Mute'}>
            <VolumeIcon className="h-5 w-5" aria-hidden />
          </button>
          <input
            type="range"
            className="range hidden w-20 sm:block lg:w-24"
            min={0}
            max={100}
            value={volume}
            disabled={!state.playerReady}
            onChange={(e) => engine.setVolume(Number(e.target.value))}
            style={{ '--progress': `${volume}%` } as CSSProperties}
            aria-label="Volume"
          />
          {onToggleFullscreen && (
            <button type="button" className="icon-btn" onClick={onToggleFullscreen} disabled={!ready} aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}>
              {isFullscreen ? <Minimize className="h-5 w-5" aria-hidden /> : <Maximize className="h-5 w-5" aria-hidden />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface LiveBadgeProps {
  atEdge: boolean;
  behind: number | null;
  /** Host only: jump everyone to the live edge. */
  onGoLive?: () => void;
}

function LiveBadge({ atEdge, behind, onGoLive }: LiveBadgeProps) {
  const label = atEdge ? 'LIVE' : `LIVE · −${formatTime(behind ?? 0)}`;
  const className = `ml-1 flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold tracking-wide transition ${
    atEdge ? 'bg-red-600 text-white' : 'bg-line/10 text-muted'
  }`;
  const dot = <span className={`h-2 w-2 rounded-full ${atEdge ? 'animate-pulse bg-white' : 'bg-red-500'}`} aria-hidden />;

  if (!onGoLive || atEdge) {
    return (
      <span className={className} title={atEdge ? 'Watching live' : 'Behind the live edge'}>
        {dot}
        {label}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onGoLive}
      className={`${className} focus-ring hover:bg-red-600 hover:text-white`}
      aria-label={`Behind live by ${formatTime(behind ?? 0)}. Jump to live for everyone`}
      title="Jump to live"
    >
      {dot}
      <span className="tabular-nums">−{formatTime(behind ?? 0)}</span>
      <span className="hidden sm:inline">· Go live</span>
    </button>
  );
}

/** Picks the audio language (per person: everyone can listen in their own language). */
function AudioMenu({ tracks, current, onChange, busy }: AudioMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const currentLabel = tracks.find((t) => t.id === current)?.label ?? 'Audio';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={`icon-btn ${open ? 'bg-line/10' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Audio language: ${currentLabel}`}
        title={`Audio: ${currentLabel}`}
      >
        <Languages className={`h-5 w-5 ${busy ? 'animate-pulse' : ''}`} aria-hidden />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            role="menu"
            aria-label="Audio language"
            initial={{ opacity: 0, y: 6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            className="absolute bottom-full right-0 z-40 mb-2 max-h-72 w-56 overflow-y-auto rounded-xl border border-white/10 bg-zinc-900/95 p-1 text-sm text-white shadow-2xl backdrop-blur"
          >
            <li className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-white/60">Audio</li>
            {tracks.map((t) => (
              <li key={t.id} role="none">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={t.id === current}
                  onClick={() => {
                    setOpen(false);
                    if (t.id !== current) onChange(t.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition hover:bg-white/10 focus-visible:bg-white/10 focus-visible:outline-none"
                >
                  <Check className={`h-4 w-4 shrink-0 ${t.id === current ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
                  <span className="truncate">{t.label}</span>
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
