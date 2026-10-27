import { AnimatePresence, motion } from 'framer-motion';
import { Check, Clapperboard, Copy, Headphones, Link2, LogOut, Play, Upload, Youtube } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { useEngineState, useRoomSession } from '../hooks/useRoomSession';
import { useSuggestions } from '../hooks/useSuggestions';
import { isAudioFile, useUploads } from '../hooks/useUploads';
import { copyText } from '../lib/format';
import { Logo } from './Logo';
import { NowPlaying } from './NowPlaying';
import { ReactionBar } from './ReactionBar';
import { Sidebar } from './Sidebar';
import { SyncPill } from './SyncPill';
import { ThemeToggle } from './ThemeToggle';
import { useToast } from './Toasts';
import { UrlForm } from './UrlForm';
import { VideoStage } from './VideoStage';
import { MovieStage } from './movie/MovieStage';
import { MoodScene } from './music/MoodScene';
import { MusicStage } from './music/MusicStage';

interface RoomProps {
  roomId: string;
  name: string;
  onLeave: (error?: string) => void;
}

export function Room({ roomId, name, onLeave }: RoomProps) {
  const { selfId, engine, socket, subtitles, connection, snapshot, messages, reactions, actions } = useRoomSession(roomId, name, onLeave);
  const state = useEngineState(engine);
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const isHost = !!snapshot && snapshot.hostId === selfId;
  const status = connection === 'connected' ? state.status : 'reconnecting';
  const videoId = snapshot?.video?.videoId ?? null;
  const suggestions = useSuggestions(videoId);
  const isMusic = snapshot?.mode === 'music';
  const isMovie = snapshot?.mode === 'movies';
  const levelRef = useRef<() => number | null>(() => null);
  const { jobs: uploads, upload } = useUploads(roomId, actions.getUploadToken);
  const [dragging, setDragging] = useState(false);
  const [effects, setEffects] = useEffectsPreference();

  useEffect(() => {
    if (isMusic && snapshot?.video) document.title = `♪ ${snapshot.video.title} · Relax Together`;
    if (isMovie && snapshot?.video) document.title = `🎬 ${snapshot.video.title} · Relax Together`;
  }, [isMusic, isMovie, snapshot?.video]);

  // Music rooms: drop songs anywhere on the page to add them.
  const dropProps = isMusic
    ? {
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files).filter(isAudioFile);
          if (files.length) upload(files);
          else toast('Drop audio files (MP3, M4A, FLAC, WAV…) to add them.', 'error');
        },
      }
    : {};

  // Everything played in this session, so autoplay never loops back to something already watched.
  const played = useRef(new Set<string>());
  useEffect(() => {
    if (videoId) played.current.add(videoId);
  }, [videoId]);

  // When the host's video ends: next in the queue, otherwise YouTube's top unseen suggestion.
  useEffect(() => {
    const queued = snapshot?.queue.length ?? 0;
    const next = snapshot?.autoplay ? suggestions.items.find((s) => !played.current.has(s.videoId)) : undefined;
    engine.onHostEnded = queued
      ? () => void actions.queueNext()
      : next
        ? () => void actions.loadVideo(next.videoId)
        : null;
  }, [engine, actions, snapshot?.queue.length, snapshot?.autoplay, suggestions.items]);

  // Host keyboard shortcuts: Space = play/pause, ←/→ = seek ±10s.
  useEffect(() => {
    if (!isHost) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      const typing = !!el.closest('input, textarea, select, [contenteditable="true"]');
      if (e.code === 'Space' && !typing && !el.closest('button, a, [role="tab"]')) {
        e.preventDefault();
        engine.togglePlay();
      } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !typing && !el.closest('[role="tab"]')) {
        e.preventDefault();
        engine.seekBy(e.key === 'ArrowLeft' ? -10 : 10);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isHost, engine]);

  const copyInvite = useCallback(async () => {
    const ok = await copyText(`${window.location.origin}/room/${roomId}`);
    if (ok) {
      setCopied(true);
      toast('Invite link copied! Send it to your friends 🎉');
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast(`Couldn't copy. Share the code ${roomId} instead.`, 'error');
    }
  }, [roomId, toast]);

  const leave = () => {
    actions.leave();
    onLeave();
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={`relative isolate flex h-dvh flex-col ${isMusic ? 'music-room' : isMovie ? 'movie-room' : ''}`} {...dropProps}>
      {/* Movie rooms dim the lights: a dark theatre backdrop whatever the theme. */}
      {isMovie && <div className="pointer-events-none fixed inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_-10%,#3a1406_0%,#0b0605_45%,#030202_100%)]" aria-hidden />}
      {isMusic && snapshot && (
        <MoodScene mood={snapshot.mood} playing={state.isPlaying && !!snapshot.video} animate={effects} getEnergy={() => levelRef.current()} />
      )}

      <header
        className={`z-20 flex h-14 shrink-0 items-center gap-2 border-b border-line/10 px-3 backdrop-blur-xl sm:h-16 sm:gap-3 sm:px-5 ${
          isMusic || isMovie ? 'bg-bg/50' : 'bg-bg/80'
        }`}
      >
        <Logo compact />
        {isMusic ? (
          <span className="hidden items-center gap-1.5 rounded-full bg-teal-500/15 px-2.5 py-1 text-xs font-semibold text-teal-700 dark:text-teal-300 xl:flex">
            <Headphones className="h-3.5 w-3.5" aria-hidden /> Music Together
          </span>
        ) : isMovie ? (
          <span className="hidden items-center gap-1.5 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-700 dark:text-amber-300 xl:flex">
            <Clapperboard className="h-3.5 w-3.5" aria-hidden /> Movies Together
          </span>
        ) : (
          <span className="hidden items-center gap-1.5 rounded-full bg-red-500/10 px-2.5 py-1 text-xs font-semibold text-red-600 dark:text-red-400 xl:flex">
            <Youtube className="h-3.5 w-3.5" aria-hidden /> YouTube Together
          </span>
        )}
        <button
          type="button"
          onClick={async () => {
            if (await copyText(roomId)) toast(`Room code ${roomId} copied`);
          }}
          className="focus-ring ml-1 hidden rounded-lg border border-line/10 bg-line/5 px-2.5 py-1 font-mono text-sm font-bold tracking-[0.2em] transition hover:bg-line/10 min-[420px]:block"
          aria-label={`Room code ${roomId}. Click to copy.`}
          title="Copy room code"
        >
          {roomId}
        </button>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <SyncPill status={status} drift={isHost ? null : state.drift} />
          <button type="button" onClick={copyInvite} className="btn-primary h-9 px-3 text-sm" aria-label="Copy invite link">
            {copied ? <Check className="h-4 w-4" aria-hidden /> : <Link2 className="h-4 w-4" aria-hidden />}
            <span className="hidden md:inline">{copied ? 'Copied!' : 'Invite'}</span>
          </button>
          <ThemeToggle />
          <button type="button" onClick={leave} className="icon-btn" aria-label="Leave room" title="Leave room">
            <LogOut className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </header>

      {!snapshot ? (
        <RoomSkeleton />
      ) : (
        <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:gap-4 sm:p-4 lg:flex-row lg:overflow-hidden">
          <section
            className="flex min-w-0 flex-col gap-3 lg:flex-1 lg:overflow-y-auto lg:pr-1 scrollbar-thin"
            aria-label={isMusic ? 'Music' : isMovie ? 'Movie' : 'Video'}
          >
            {isMovie ? (
              <MovieStage
                engine={engine}
                state={state}
                snapshot={snapshot}
                selfId={selfId}
                isHost={isHost}
                reactions={reactions}
                actions={actions}
                socket={socket}
                sharedSubtitles={subtitles}
              />
            ) : isMusic ? (
              <MusicStage
                engine={engine}
                state={state}
                snapshot={snapshot}
                isHost={isHost}
                reactions={reactions}
                actions={actions}
                uploads={uploads}
                onUpload={upload}
                levelRef={levelRef}
                effects={effects}
                onEffectsChange={setEffects}
              />
            ) : (
              <>
                <VideoStage engine={engine} state={state} isHost={isHost} reactions={reactions} />

                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <NowPlaying video={snapshot.video} isLive={!!snapshot.video?.isLive || state.isLive} />
                  <div className="flex justify-center sm:justify-end">
                    <ReactionBar onReact={actions.sendReaction} />
                  </div>
                </div>

                {isHost && (
                  <div className="glass rounded-2xl p-3 sm:p-4">
                    <p className="mb-2 flex items-center gap-2 text-sm font-semibold">
                      <Play className="h-4 w-4 text-fuchsia-500" aria-hidden /> Play a video for everyone
                    </p>
                    <UrlForm
                      label="YouTube link to play now"
                      placeholder="Paste a YouTube link…"
                      submitLabel="Play"
                      submitIcon={Play}
                      onSubmit={actions.loadVideo}
                    />
                  </div>
                )}

                {!isHost && (
                  <p className="flex items-center justify-center gap-2 text-center text-xs text-muted">
                    <Copy className="h-3.5 w-3.5" aria-hidden /> Room code <span className="font-mono font-bold tracking-widest text-fg">{roomId}</span>
                  </p>
                )}
              </>
            )}
          </section>

          <Sidebar
            snapshot={snapshot}
            selfId={selfId}
            isHost={isHost}
            messages={messages}
            suggestions={suggestions}
            actions={actions}
            uploads={uploads}
            onUpload={upload}
          />
        </main>
      )}

      <AnimatePresence>
        {dragging && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-3xl border-2 border-dashed border-fuchsia-400 bg-black/50 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-3 text-white">
              <Upload className="h-12 w-12" aria-hidden />
              <p className="text-xl font-bold">Drop songs to add them to the party</p>
              <p className="text-sm text-white/75">MP3, M4A, FLAC, WAV, OGG · up to 50 MB each</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

const EFFECTS_KEY = 'wp:effects';

/** Per-person (this browser) switch for the animated mood scenes; useful on slower devices. */
function useEffectsPreference() {
  const [effects, setEffects] = useState(() => {
    try {
      return localStorage.getItem(EFFECTS_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const update = useCallback((on: boolean) => {
    setEffects(on);
    try {
      localStorage.setItem(EFFECTS_KEY, on ? 'on' : 'off');
    } catch {
      /* storage unavailable */
    }
  }, []);
  return [effects, update] as const;
}

function RoomSkeleton() {
  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 p-3 sm:p-4 lg:flex-row" aria-busy="true" aria-label="Joining room">
      <div className="flex flex-col gap-3 lg:flex-1">
        <div className="skeleton aspect-video w-full rounded-2xl" />
        <div className="skeleton h-20 w-full rounded-2xl" />
        <div className="flex gap-3">
          <div className="skeleton h-11 w-20" />
          <div className="skeleton h-11 flex-1" />
        </div>
      </div>
      <div className="glass flex min-h-[320px] flex-col gap-3 rounded-2xl p-4 lg:w-[380px]">
        <div className="skeleton h-10 w-full" />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className="skeleton h-9 w-9 shrink-0 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <div className="skeleton h-3 w-1/3" />
              <div className="skeleton h-3 w-4/5" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
