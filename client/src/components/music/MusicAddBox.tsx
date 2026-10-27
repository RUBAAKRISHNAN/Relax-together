import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, ListPlus, Loader2, Play, Plus, Search, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { MusicSearchResponse, SuggestedVideo } from '@shared/types';
import type { UploadJob } from '../../hooks/useUploads';
import { AUDIO_ACCEPT } from '../../hooks/useUploads';
import { SERVER_URL } from '../../lib/env';
import { useToast } from '../Toasts';

interface MusicAddBoxProps {
  isHost: boolean;
  /** Something is already playing (decides what Enter does for the host). */
  hasTrack: boolean;
  onPlay: (input: string) => Promise<string | null>;
  onQueue: (input: string) => Promise<string | null>;
  onUpload: (files: File[]) => void;
  uploads: UploadJob[];
  autoFocus?: boolean;
}

const SOURCES = ['Spotify', 'Apple Music', 'YouTube', 'JioSaavn', 'SoundCloud', 'Your files'];
const isLink = (s: string) => /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(s);

/** Search songs as you type, paste a link from any music app, or upload files from your device. */
export function MusicAddBox({ isHost, hasTrack, onPlay, onQueue, onUpload, uploads, autoFocus }: MusicAddBoxProps) {
  const [value, setValue] = useState('');
  const [results, setResults] = useState<SuggestedVideo[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const inputId = useId();
  const trimmed = value.trim();
  const link = isLink(trimmed);

  // Live search (debounced) for anything that isn't a link.
  useEffect(() => {
    if (link || trimmed.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`${SERVER_URL}/api/music/search?q=${encodeURIComponent(trimmed)}`, { signal: controller.signal })
        .then((r) => r.json() as Promise<MusicSearchResponse & { error?: string }>)
        .then((body) => {
          setResults(body.results?.slice(0, 6) ?? []);
          setSearching(false);
        })
        .catch((err: Error) => err.name !== 'AbortError' && setSearching(false));
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, link]);

  const run = async (key: string, action: () => Promise<string | null>, success?: string) => {
    setBusy(key);
    setError(null);
    const err = await action();
    setBusy(null);
    if (err) setError(err);
    else {
      if (success) toast(success);
      setValue('');
      setResults([]);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!trimmed) return;
    // Enter: the host starts the music if it's quiet; otherwise it goes on the queue.
    if (isHost && !hasTrack) void run('submit', () => onPlay(trimmed));
    else void run('submit', () => onQueue(trimmed), isHost ? 'Added to the queue' : 'Suggested to the room');
  };

  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} className="flex gap-2" role="search">
        <label htmlFor={inputId} className="sr-only">
          Search songs or paste a music link
        </label>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id={inputId}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="Search songs or paste a link"
            autoComplete="off"
            spellCheck={false}
            autoFocus={autoFocus}
            className="input py-2.5 pl-10 pr-9 text-sm"
            aria-invalid={!!error}
          />
          {(searching || busy === 'submit') && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted" aria-label="Working" />}
        </div>
        {link ? (
          <button type="submit" className="btn-primary shrink-0 px-4 text-sm" disabled={!!busy}>
            {isHost && !hasTrack ? <Play className="h-4 w-4 fill-white" aria-hidden /> : <ListPlus className="h-4 w-4" aria-hidden />}
            <span className="hidden min-[400px]:inline">{isHost && !hasTrack ? 'Play' : 'Add'}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="btn-ghost shrink-0 px-3 text-sm"
            aria-label="Upload songs from your device"
            title="Upload songs from your device"
          >
            <Upload className="h-4 w-4" aria-hidden />
            <span className="hidden min-[400px]:inline">Upload</span>
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept={AUDIO_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => {
            onUpload(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </form>

      {!trimmed && !uploads.length && (
        <p className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-muted">
          Works with
          {SOURCES.map((s) => (
            <span key={s} className="rounded-full bg-line/10 px-2 py-0.5 font-medium">
              {s}
            </span>
          ))}
        </p>
      )}

      <AnimatePresence>
        {error && (
          <motion.p
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-start gap-1.5 overflow-hidden px-1 text-sm text-red-600 dark:text-red-400"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
          </motion.p>
        )}
      </AnimatePresence>

      {results.length > 0 && (
        <ul className="flex flex-col gap-0.5 rounded-xl border border-line/10 bg-card/80 p-1 backdrop-blur" aria-label="Search results">
          {results.map((r) => (
            <li key={r.videoId} className="flex items-center gap-2.5 rounded-lg p-1.5 transition hover:bg-line/5">
              <div className="relative shrink-0">
                <img src={r.thumbnail} alt="" className="aspect-video w-16 rounded-md object-cover" loading="lazy" />
                {r.duration && <span className="absolute bottom-0.5 right-0.5 rounded bg-black/75 px-1 text-[9px] font-semibold text-white">{r.duration}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={r.title}>
                  {r.title}
                </p>
                <p className="truncate text-xs text-muted">{r.author}</p>
              </div>
              {isHost && (
                <button
                  type="button"
                  onClick={() => run(r.videoId, () => onPlay(r.videoId))}
                  disabled={!!busy}
                  className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-pink-600 text-white"
                  aria-label={`Play ${r.title} now`}
                  title="Play now for everyone"
                >
                  {busy === r.videoId ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5 translate-x-px fill-white" aria-hidden />}
                </button>
              )}
              <button
                type="button"
                onClick={() => run(`q-${r.videoId}`, () => onQueue(r.videoId), 'Added to the queue')}
                disabled={!!busy}
                className="icon-btn h-8 w-8 border border-line/10"
                aria-label={`Add ${r.title} to the queue`}
                title="Add to queue"
              >
                {busy === `q-${r.videoId}` ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
              </button>
            </li>
          ))}
        </ul>
      )}

      {uploads.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id} className="rounded-lg border border-line/10 bg-line/5 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{u.name}</span>
                <span className={u.status === 'error' ? 'text-red-600 dark:text-red-400' : 'text-muted'}>
                  {u.status === 'waiting' ? 'Waiting…' : u.status === 'uploading' ? `${Math.round(u.progress * 100)}%` : u.status === 'done' ? 'Done ✓' : 'Failed'}
                </span>
              </div>
              {u.status === 'error' ? (
                <p className="mt-1 text-red-600 dark:text-red-400">{u.error}</p>
              ) : (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line/10">
                  <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-pink-500 transition-[width]" style={{ width: `${u.progress * 100}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
