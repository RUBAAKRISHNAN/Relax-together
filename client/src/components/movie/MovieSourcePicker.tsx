import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, Check, FolderOpen, Link2, Loader2, Radio, X } from 'lucide-react';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { MovieSource } from '@shared/types';
import { fingerprintFile, probeVideo } from '../../lib/fingerprint';
import { MOVIE_ACCEPT, rememberFile } from './localFiles';

type Mode = 'local' | 'url' | 'stream';

interface MovieSourcePickerProps {
  onLoad: (source: MovieSource) => Promise<string | null>;
  onCancel?: () => void;
}

const OPTIONS: { mode: Mode; icon: typeof FolderOpen; title: string; tag?: string; body: string; points: string[] }[] = [
  {
    mode: 'local',
    icon: FolderOpen,
    title: 'Everyone has the file',
    tag: 'Best · zero lag',
    body: 'Each person opens their own copy of the same movie. Only play, pause and seek are shared.',
    points: ['Full original quality', 'No buffering, any internet speed', 'Version check for everyone'],
  },
  {
    mode: 'url',
    icon: Link2,
    title: 'Video link',
    body: 'A direct link to a video file (.mp4, .webm) or an HLS stream (.m3u8). Everyone streams it in sync.',
    points: ['Dropbox and cloud storage links', 'Works for large groups', 'Quality depends on the source'],
  },
  {
    mode: 'stream',
    icon: Radio,
    title: 'Stream from my device',
    body: 'Only you have the movie? Your browser streams it to everyone, peer-to-peer.',
    points: ['Nobody else needs the file', 'Best for 2–5 viewers', 'Uses your upload speed'],
  },
];

/** "https://www.dropbox.com/s/…/movie.mp4?dl=0" → a link that streams the file itself. */
function normalizeLink(input: string): string {
  try {
    const url = new URL(input.trim());
    if (url.hostname.endsWith('dropbox.com')) {
      url.searchParams.delete('dl');
      url.searchParams.set('raw', '1');
    }
    return url.toString();
  } catch {
    return input.trim();
  }
}

const titleFromFileName = (name: string) => name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').trim() || name;

export function MovieSourcePicker({ onLoad, onCancel }: MovieSourcePickerProps) {
  const [mode, setMode] = useState<Mode>('local');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const pickFile = async (file: File) => {
    setError(null);
    setBusy(`Reading ${file.name}…`);
    const url = URL.createObjectURL(file);
    try {
      const [{ duration, hasVideo }, fingerprint] = await Promise.all([probeVideo(url), fingerprintFile(file)]);
      if (!hasVideo) throw new Error("This file has no picture your browser can show (HEVC/x265?). Convert it to MP4 (H.264) with HandBrake.");
      rememberFile(fingerprint, file);
      setBusy('Starting movie night…');
      const name = titleFromFileName(file.name);
      const err = await onLoad(
        mode === 'stream' ? { kind: 'stream', name, size: file.size, fingerprint, duration } : { kind: 'local', name, size: file.size, fingerprint, duration },
      );
      if (err) setError(err);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      URL.revokeObjectURL(url);
      setBusy(null);
    }
  };

  const submitLink = async (e: FormEvent) => {
    e.preventDefault();
    const url = normalizeLink(link);
    if (!/^https?:\/\//i.test(url)) return setError('Paste a link starting with https://');
    if (/drive\.google\.com/.test(url)) {
      return setError("Google Drive doesn't allow streaming big videos to other sites. Use Dropbox, your own storage, or “Everyone has the file”.");
    }
    setError(null);
    setBusy('Checking the link…');
    try {
      await probeVideo(url);
    } catch {
      setBusy(null);
      return setError("That link didn't open as a video. It must point at the video file itself (or an .m3u8 playlist), not a web page.");
    }
    const name = linkTitle.trim() || titleFromFileName(decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')) || 'Movie';
    const err = await onLoad({ kind: 'url', url, name });
    setBusy(null);
    if (err) setError(err);
  };

  return (
    <div className="glass rounded-2xl p-4 sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold">Pick tonight's movie 🍿</h2>
          <p className="text-sm text-muted">How will everyone watch it?</p>
        </div>
        {onCancel && (
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Close">
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="How to watch">
        {OPTIONS.map(({ mode: m, icon: Icon, title, tag, body, points }) => {
          const active = mode === m;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              className={`focus-ring relative flex flex-col gap-2 rounded-2xl border p-4 text-left transition ${
                active ? 'border-amber-400/70 bg-amber-500/10 shadow-lg shadow-amber-500/10' : 'border-line/10 bg-line/[0.03] hover:bg-line/[0.06]'
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className={`grid h-10 w-10 place-items-center rounded-xl ${active ? 'bg-gradient-to-br from-amber-500 to-red-500 text-white' : 'bg-line/10'}`}>
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
                {tag && <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">{tag}</span>}
              </span>
              <span className="font-semibold">{title}</span>
              <span className="text-xs text-muted">{body}</span>
              <ul className="mt-1 flex flex-col gap-1 text-xs">
                {points.map((p) => (
                  <li key={p} className="flex items-center gap-1.5">
                    <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden /> {p}
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {mode === 'url' ? (
          <form onSubmit={submitLink} className="flex flex-col gap-2 sm:flex-row" noValidate>
            <label className="sr-only" htmlFor="movie-link">
              Video link
            </label>
            <input
              id="movie-link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://…/movie.mp4 or …/playlist.m3u8"
              className="input min-w-0 flex-[2] py-2.5 text-sm"
              inputMode="url"
              autoComplete="off"
            />
            <label className="sr-only" htmlFor="movie-title">
              Title (optional)
            </label>
            <input
              id="movie-title"
              value={linkTitle}
              onChange={(e) => setLinkTitle(e.target.value)}
              placeholder="Title (optional)"
              className="input min-w-0 flex-1 py-2.5 text-sm"
            />
            <PrimaryButton busy={!!busy} disabled={!link.trim()}>
              Start
            </PrimaryButton>
          </form>
        ) : (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line/15 p-5 text-center"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files[0];
              if (file) void pickFile(file);
            }}
          >
            <p className="text-sm text-muted">
              {mode === 'local'
                ? 'Open your copy of the movie. Friends will be asked to open theirs.'
                : 'Open the movie you want to stream. Keep this tab open while everyone watches.'}
            </p>
            <PrimaryButton busy={!!busy} onClick={() => fileRef.current?.click()} type="button">
              <FolderOpen className="h-4 w-4" aria-hidden /> Choose movie file
            </PrimaryButton>
            <p className="text-[11px] text-muted">MP4 (H.264 + AAC) and WebM play in every browser; most MKV files work in Chrome and Edge. Nothing is uploaded.</p>
            <input
              ref={fileRef}
              type="file"
              accept={MOVIE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void pickFile(file);
              }}
            />
          </div>
        )}
      </div>

      <AnimatePresence>
        {(busy || error) && (
          <motion.p
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className={`flex items-start gap-2 overflow-hidden pt-3 text-sm ${error ? 'text-red-600 dark:text-red-400' : 'text-muted'}`}
            role={error ? 'alert' : 'status'}
          >
            {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden />}
            {error ?? busy}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

function PrimaryButton({ busy, children, ...rest }: { busy: boolean; children: ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="submit"
      {...rest}
      disabled={busy || rest.disabled}
      className="btn shrink-0 bg-gradient-to-r from-amber-500 to-red-600 px-5 py-2.5 text-sm text-white shadow-lg shadow-red-600/25 hover:brightness-110"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
}
