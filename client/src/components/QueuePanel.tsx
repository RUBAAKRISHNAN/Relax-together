import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Check, ListPlus, Loader2, Play, Plus, RefreshCw, SkipForward, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { QueueItem, SuggestedVideo } from '@shared/types';
import type { RoomActions } from '../hooks/useRoomSession';
import type { SuggestionsState } from '../hooks/useSuggestions';
import type { UploadJob } from '../hooks/useUploads';
import { ORIGIN_LABELS, ORIGIN_STYLES, assetUrl } from '../lib/media';
import { MusicAddBox } from './music/MusicAddBox';
import { useToast } from './Toasts';
import { UrlForm } from './UrlForm';

interface QueuePanelProps {
  queue: QueueItem[];
  selfId: string;
  isHost: boolean;
  autoplay: boolean;
  hasVideo: boolean;
  currentVideoId: string | null;
  isMusic: boolean;
  suggestions: SuggestionsState;
  actions: RoomActions;
  uploads: UploadJob[];
  onUpload: (files: File[]) => void;
}

export function QueuePanel({ queue, selfId, isHost, autoplay, hasVideo, currentVideoId, isMusic, suggestions, actions, uploads, onUpload }: QueuePanelProps) {
  const toast = useToast();
  const run = async (action: () => Promise<string | null>, success?: string) => {
    const err = await action();
    if (err) toast(err, 'error');
    else if (success) toast(success);
    return err;
  };
  const queuedIds = new Set(queue.map((q) => q.video.videoId));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line/10 p-3">
        {isMusic ? (
          <MusicAddBox isHost={isHost} hasTrack={hasVideo} onPlay={actions.loadVideo} onQueue={actions.queueAdd} onUpload={onUpload} uploads={uploads} />
        ) : (
          <UrlForm
            label="Suggest a YouTube video"
            placeholder={isHost ? 'Add a YouTube link to the queue…' : 'Suggest a YouTube link…'}
            submitLabel="Add"
            submitIcon={ListPlus}
            onSubmit={async (url) => {
              const err = await actions.queueAdd(url);
              if (!err) toast('Added to the queue');
              return err;
            }}
          />
        )}
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
        <SectionHeading title="Queue" count={queue.length}>
          {isHost && queue.length > 0 && (
            <button type="button" onClick={() => run(actions.queueNext)} className="btn-ghost px-2.5 py-1 text-xs">
              <SkipForward className="h-3.5 w-3.5" aria-hidden /> Play next
            </button>
          )}
        </SectionHeading>

        {queue.length === 0 ? (
          <p className="mb-5 rounded-xl border border-dashed border-line/15 px-4 py-4 text-center text-sm text-muted">
            {isMusic
              ? 'Queue is empty. Search a song, paste a playlist link, or drop files here.'
              : isHost
                ? 'Queue is empty. Add a link above or pick from the suggestions below.'
                : 'Queue is empty. Suggest something 🍿'}
          </p>
        ) : (
          <ol className="mb-5 flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {queue.map((item, i) => {
                const canRemove = isHost || item.addedBy.id === selfId;
                return (
                  <motion.li
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 20 }}
                    className="flex items-center gap-3 rounded-xl border border-line/10 bg-line/[0.03] p-2"
                  >
                    <Thumb src={assetUrl(item.video.thumbnail)} badge={String(i + 1)} />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-2 text-sm font-semibold leading-snug" title={item.video.title}>
                        {item.video.title}
                      </p>
                      {isMusic && item.video.author && <p className="truncate text-xs text-fg/75">{item.video.author}</p>}
                      <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
                        {item.status === 'resolving' ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Finding the song…
                          </>
                        ) : item.status === 'failed' ? (
                          <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                            <AlertCircle className="h-3 w-3" aria-hidden /> Couldn't find this one
                          </span>
                        ) : (
                          <>
                            {isMusic && item.video.origin && (
                              <span className={`rounded px-1.5 py-px text-[10px] font-semibold ${ORIGIN_STYLES[item.video.origin]}`}>
                                {ORIGIN_LABELS[item.video.origin]}
                              </span>
                            )}
                            <span className="truncate">by {item.addedBy.id === selfId ? 'you' : item.addedBy.name}</span>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      {isHost && item.status !== 'failed' && (
                        <PlayButton label={`Play ${item.video.title} now`} onClick={() => run(() => actions.queuePlay(item.id))} />
                      )}
                      {canRemove && (
                        <button
                          type="button"
                          onClick={() => run(() => actions.queueRemove(item.id))}
                          className="icon-btn h-8 w-8"
                          aria-label={`Remove ${item.video.title} from the queue`}
                          title="Remove"
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </button>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
        )}

        <SectionHeading title={isMusic ? 'More like this' : 'Suggested for you'} icon>
          <AutoplaySwitch
            enabled={autoplay}
            disabled={!isHost}
            onChange={(enabled) => run(() => actions.setAutoplay(enabled), enabled ? 'Autoplay on' : 'Autoplay off')}
          />
        </SectionHeading>

        {!hasVideo ? (
          <p className="px-2 py-4 text-center text-sm text-muted">Suggestions appear once something is playing.</p>
        ) : currentVideoId?.startsWith('file:') ? (
          <p className="px-2 py-4 text-center text-sm text-muted">Suggestions appear for streamed songs. Uploaded tracks don't have any.</p>
        ) : suggestions.status === 'loading' ? (
          <ul className="flex flex-col gap-2" aria-label="Loading suggestions">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className="flex gap-3 p-1">
                <div className="skeleton aspect-video w-28 shrink-0" />
                <div className="flex flex-1 flex-col gap-2 pt-1">
                  <div className="skeleton h-3 w-full" />
                  <div className="skeleton h-3 w-2/3" />
                  <div className="skeleton h-2.5 w-1/3" />
                </div>
              </li>
            ))}
          </ul>
        ) : suggestions.status === 'error' ? (
          <div className="flex flex-col items-center gap-2 px-4 py-4 text-center text-sm text-muted" role="alert">
            <p>{suggestions.error}</p>
            <button type="button" onClick={suggestions.retry} className="btn-ghost px-3 py-1.5 text-xs">
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again
            </button>
          </div>
        ) : suggestions.items.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-muted">No suggestions for this video.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {suggestions.items.map((s) => (
              <SuggestionRow
                key={s.videoId}
                video={s}
                isHost={isHost}
                queued={queuedIds.has(s.videoId)}
                onPlay={() => run(() => actions.loadVideo(s.videoId))}
                onQueue={() => run(() => actions.queueAdd(s.videoId), isHost ? 'Added to the queue' : 'Suggested to the host')}
              />
            ))}
          </ul>
        )}
        {hasVideo && autoplay && queue.length === 0 && suggestions.items.length > 0 && (
          <p className="mt-3 px-2 text-center text-xs text-muted">When this video ends, the top suggestion plays automatically.</p>
        )}
      </div>
    </div>
  );
}

function SectionHeading({ title, count, icon, children }: { title: string; count?: number; icon?: boolean; children?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2 px-1">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
        {icon && <Sparkles className="h-3.5 w-3.5 text-fuchsia-500" aria-hidden />}
        {title}
        {count !== undefined && count > 0 && <span className="rounded-full bg-line/10 px-1.5 text-[10px] text-fg">{count}</span>}
      </h3>
      {children}
    </div>
  );
}

function Thumb({ src, badge, live }: { src: string; badge?: string | null; live?: boolean }) {
  return (
    <div className="relative shrink-0">
      <img src={src} alt="" loading="lazy" className="aspect-video w-24 rounded-lg object-cover sm:w-28" />
      {live ? (
        <span className="absolute bottom-1 right-1 flex items-center gap-1 rounded bg-red-600 px-1 text-[10px] font-bold text-white">
          <span className="h-1 w-1 rounded-full bg-white" aria-hidden /> LIVE
        </span>
      ) : (
        badge && <span className="absolute bottom-1 right-1 rounded bg-black/75 px-1 text-[10px] font-semibold tabular-nums text-white">{badge}</span>
      )}
    </div>
  );
}

function PlayButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="focus-ring grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-pink-600 text-white transition hover:brightness-110"
      aria-label={label}
      title="Play now for everyone"
    >
      <Play className="h-3.5 w-3.5 translate-x-px fill-white" aria-hidden />
    </button>
  );
}

interface SuggestionRowProps {
  video: SuggestedVideo;
  isHost: boolean;
  queued: boolean;
  onPlay: () => void;
  onQueue: () => Promise<string | null>;
}

function SuggestionRow({ video, isHost, queued, onPlay, onQueue }: SuggestionRowProps) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="group flex items-center gap-3 rounded-xl p-1.5 transition hover:bg-line/5">
      <Thumb src={video.thumbnail} badge={video.duration} live={video.isLive} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug" title={video.title}>
          {video.title}
        </p>
        {video.author && <p className="mt-0.5 truncate text-xs text-muted">{video.author}</p>}
        {video.meta && <p className="truncate text-[11px] text-muted/80">{video.meta}</p>}
      </div>
      <div className="flex shrink-0 flex-col gap-1">
        {isHost && <PlayButton label={`Play ${video.title} now`} onClick={onPlay} />}
        <button
          type="button"
          disabled={queued || busy}
          onClick={async () => {
            setBusy(true);
            await onQueue();
            setBusy(false);
          }}
          className="icon-btn h-8 w-8 border border-line/10"
          aria-label={queued ? `${video.title} is in the queue` : `Add ${video.title} to the queue`}
          title={queued ? 'In the queue' : 'Add to queue'}
        >
          {queued ? <Check className="h-4 w-4 text-emerald-500" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
        </button>
      </div>
    </li>
  );
}

function AutoplaySwitch({ enabled, disabled, onChange }: { enabled: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      className={`flex items-center gap-2 text-xs font-medium ${disabled ? 'text-muted' : 'cursor-pointer'}`}
      title={disabled ? 'Only the host can change autoplay' : 'Play the top suggestion when the queue runs out'}
    >
      Autoplay
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Autoplay suggestions"
        disabled={disabled}
        onClick={() => onChange(!enabled)}
        className={`focus-ring relative h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed ${
          enabled ? 'bg-gradient-to-r from-violet-600 to-pink-600' : 'bg-line/20'
        } ${disabled ? 'opacity-60' : ''}`}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
          className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow ${enabled ? 'right-0.5' : 'left-0.5'}`}
        />
      </button>
    </label>
  );
}
