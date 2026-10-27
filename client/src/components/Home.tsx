import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowRight,
  Bell,
  Check,
  Clapperboard,
  Headphones,
  Link2,
  Loader2,
  MessageCircle,
  PartyPopper,
  Sofa,
  Sparkles,
  Timer,
  Users,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_NAME_LENGTH, normalizeRoomCode } from '@shared/constants';
import type { ExperienceMode } from '@shared/types';
import { SERVER_URL } from '../lib/env';
import { getSavedName, saveName } from '../lib/identity';
import { Logo } from './Logo';
import { ThemeToggle } from './ThemeToggle';
import { useToast } from './Toasts';

interface HomeProps {
  inviteCode: string | null;
  error: string | null;
  onEnter: (roomId: string, name: string) => void;
}

interface Experience {
  mode: ExperienceMode;
  title: string;
  tagline: string;
  icon: LucideIcon;
  gradient: string;
  glow: string;
  features: string[];
  available: boolean;
}

const EXPERIENCES: Experience[] = [
  {
    mode: 'youtube',
    title: 'YouTube Together',
    tagline: 'Any video or live stream, perfectly in sync for everyone in the room.',
    icon: Youtube,
    gradient: 'from-red-500 via-rose-500 to-pink-500',
    glow: 'shadow-rose-500/30',
    features: ['Frame-perfect sync', 'Live streams', 'Smart "up next" picks', 'Chat & reactions'],
    available: true,
  },
  {
    mode: 'music',
    title: 'Music Together',
    tagline: 'Songs from Spotify, Apple Music, YouTube or your own files, heard by everyone at the same beat.',
    icon: Headphones,
    gradient: 'from-emerald-500 via-teal-500 to-cyan-500',
    glow: 'shadow-teal-500/30',
    features: ['Spotify & Apple Music links', 'Upload your own songs', '7 animated moods', 'Whole playlists in one paste'],
    available: true,
  },
  {
    mode: 'movies',
    title: 'Movies Together',
    tagline: 'Movie nights on the couch, even when the couch is in five cities.',
    icon: Clapperboard,
    gradient: 'from-amber-500 via-orange-500 to-red-500',
    glow: 'shadow-orange-500/30',
    features: ['Everyone plays their own copy: zero lag', 'Or a video link, or stream from your device', 'Ready check + shared subtitles', 'Theatre mode with ambient glow 🍿'],
    available: true,
  },
];

const STEPS = [
  { icon: Sofa, title: 'Grab a seat', text: 'Pick a name and start a room. No sign-up, ever.' },
  { icon: Link2, title: 'Invite your people', text: 'Share the link or the 6-letter code with friends.' },
  { icon: PartyPopper, title: 'Relax together', text: 'Play, pause and seek land for everyone at the same moment.' },
];

const networkError = "Can't reach the Relax Together server. Is it running?";

export function Home({ inviteCode, error, onEnter }: HomeProps) {
  const [name, setName] = useState(getSavedName);
  const [code, setCode] = useState(inviteCode ?? '');
  const [busy, setBusy] = useState<'create' | 'music' | 'movies' | 'join' | null>(null);
  const [formError, setFormError] = useState<string | null>(error);
  const nameRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  useEffect(() => setFormError(error), [error]);
  useEffect(() => {
    if (inviteCode) setCode(inviteCode);
  }, [inviteCode]);

  const validName = (): string | null => {
    const n = name.trim();
    if (!n) {
      setFormError('Pick a display name first.');
      nameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      nameRef.current?.focus({ preventScroll: true });
      return null;
    }
    if (Array.from(n).length > MAX_NAME_LENGTH) {
      setFormError(`Names can be up to ${MAX_NAME_LENGTH} characters.`);
      return null;
    }
    saveName(n);
    return n;
  };

  const createRoom = async (mode: ExperienceMode = 'youtube') => {
    const n = validName();
    if (!n) return;
    setBusy(mode === 'youtube' ? 'create' : mode);
    setFormError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json()) as { roomId?: string; error?: string };
      if (!res.ok || !data.roomId) throw new Error(data.error ?? 'Could not create a room.');
      onEnter(data.roomId, n);
    } catch (e) {
      setFormError(e instanceof TypeError ? networkError : (e as Error).message);
      setBusy(null);
    }
  };

  const joinRoom = async (e: FormEvent) => {
    e.preventDefault();
    const n = validName();
    if (!n) return;
    const roomId = normalizeRoomCode(code);
    if (!roomId) {
      setFormError('Enter a 6-character room code or paste an invite link.');
      return;
    }
    setBusy('join');
    setFormError(null);
    try {
      const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}`);
      if (res.status === 404) throw new Error("That room doesn't exist or has expired. Double-check the code?");
      if (!res.ok) throw new Error('Could not join the room.');
      onEnter(roomId, n);
    } catch (err) {
      setFormError(err instanceof TypeError ? networkError : (err as Error).message);
      setBusy(null);
    }
  };

  const invited = !!inviteCode;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="relative min-h-full overflow-x-hidden">
      <AnimatedBackground />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <ThemeToggle />
      </header>

      <main className="relative z-10 mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        {/* Hero */}
        <div className="grid items-center gap-10 pt-4 lg:grid-cols-[1.15fr_1fr] lg:gap-14 lg:pt-12">
          <section>
            <FadeUp delay={0.05}>
              <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-1 text-xs font-semibold text-fuchsia-700 dark:text-fuchsia-300">
                <Sparkles className="h-3.5 w-3.5" aria-hidden /> Your cozy corner of the internet
              </span>
            </FadeUp>
            <FadeUp delay={0.1}>
              <h1 className="text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
                Relax{' '}
                <span className="animate-gradient bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400 bg-[length:200%_auto] bg-clip-text text-transparent">
                  together
                </span>
                ,<br className="hidden sm:block" /> wherever you are.
              </h1>
            </FadeUp>
            <FadeUp delay={0.15}>
              <p className="mt-5 max-w-lg text-base text-muted sm:text-lg">
                Watch, listen and hang out with your favorite people in real time. Everything stays in sync, and nobody needs an account.
              </p>
            </FadeUp>
            <FadeUp delay={0.2}>
              <dl className="mt-8 grid max-w-md grid-cols-3 gap-3">
                {[
                  { icon: Timer, value: '<0.3s', label: 'sync drift' },
                  { icon: Users, value: '50', label: 'friends per room' },
                  { icon: Headphones, value: '7', label: 'music moods' },
                ].map(({ icon: Icon, value, label }) => (
                  <div key={label} className="glass rounded-2xl px-3 py-3">
                    <Icon className="mb-1.5 h-4 w-4 text-fuchsia-500 dark:text-fuchsia-400" aria-hidden />
                    <dt className="sr-only">{label}</dt>
                    <dd className="text-lg font-extrabold leading-none">{value}</dd>
                    <dd className="mt-1 text-xs text-muted">{label}</dd>
                  </div>
                ))}
              </dl>
            </FadeUp>
          </section>

          {/* Your seat */}
          <motion.section
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: 0.15, type: 'spring', stiffness: 160, damping: 20 }}
            className="glass rounded-3xl p-5 sm:p-7"
            aria-label="Start or join a room"
          >
            {invited ? (
              <div className="mb-5 flex items-center gap-3 rounded-2xl border border-fuchsia-400/30 bg-gradient-to-r from-violet-500/10 to-pink-500/10 p-3.5">
                <PartyPopper className="h-6 w-6 shrink-0 text-fuchsia-500" aria-hidden />
                <p className="text-sm">
                  You're invited to room <span className="font-mono font-bold tracking-widest">{inviteCode}</span>. Pick a name and jump in!
                </p>
              </div>
            ) : (
              <h2 className="mb-4 text-lg font-bold">Grab your seat 🛋️</h2>
            )}

            <label htmlFor="display-name" className="mb-2 block text-sm font-semibold">
              Your display name
            </label>
            <input
              id="display-name"
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFormError(null);
              }}
              maxLength={MAX_NAME_LENGTH * 2}
              placeholder="e.g. Sam"
              autoComplete="nickname"
              autoFocus={!name}
              className="input text-base"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !invited) void createRoom('youtube');
              }}
            />

            {!invited && (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <button type="button" onClick={() => createRoom('youtube')} disabled={!!busy} className="btn-primary py-4 text-base">
                    {busy === 'create' ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Youtube className="h-5 w-5" aria-hidden />}
                    Watch party
                  </button>
                  <button
                    type="button"
                    onClick={() => createRoom('music')}
                    disabled={!!busy}
                    className="btn bg-gradient-to-r from-emerald-600 to-cyan-600 py-4 text-base text-white shadow-lg shadow-teal-600/25 hover:brightness-110"
                  >
                    {busy === 'music' ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Headphones className="h-5 w-5" aria-hidden />}
                    Music party
                  </button>
                  <button
                    type="button"
                    onClick={() => createRoom('movies')}
                    disabled={!!busy}
                    className="btn bg-gradient-to-r from-amber-500 to-red-600 py-4 text-base text-white shadow-lg shadow-red-600/25 hover:brightness-110"
                  >
                    {busy === 'movies' ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Clapperboard className="h-5 w-5" aria-hidden />}
                    Movie night
                  </button>
                </div>
                <div className="my-6 flex items-center gap-3 text-xs font-medium uppercase tracking-wider text-muted">
                  <span className="h-px flex-1 bg-line/10" /> or join friends <span className="h-px flex-1 bg-line/10" />
                </div>
              </>
            )}

            <form onSubmit={joinRoom} className={invited ? 'mt-4' : ''} noValidate>
              <label htmlFor="room-code" className="sr-only">
                Room code or invite link
              </label>
              <div className="flex flex-col gap-3 sm:flex-row">
                <input
                  id="room-code"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setFormError(null);
                  }}
                  placeholder="Room code or invite link"
                  autoComplete="off"
                  spellCheck={false}
                  className="input font-mono uppercase tracking-widest placeholder:font-sans placeholder:normal-case placeholder:tracking-normal"
                />
                <button type="submit" disabled={!!busy} className={`${invited ? 'btn-primary py-4' : 'btn-ghost py-3'} shrink-0 px-6 text-base`}>
                  {busy === 'join' ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <ArrowRight className="h-5 w-5" aria-hidden />}
                  {invited ? 'Join the party' : 'Join'}
                </button>
              </div>
            </form>

            {invited && (
              <button
                type="button"
                onClick={() => createRoom('youtube')}
                disabled={!!busy}
                className="focus-ring mt-4 w-full rounded-lg text-sm text-muted underline-offset-4 hover:text-fg hover:underline"
              >
                or start your own room
              </button>
            )}

            <AnimatePresence>
              {formError && (
                <motion.p
                  role="alert"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden pt-4 text-sm font-medium text-red-600 dark:text-red-400"
                >
                  {formError}
                </motion.p>
              )}
            </AnimatePresence>
          </motion.section>
        </div>

        {/* Experiences */}
        <section className="mt-20 sm:mt-24" aria-labelledby="experiences-heading">
          <div className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">Pick your vibe</p>
              <h2 id="experiences-heading" className="mt-1 text-3xl font-extrabold tracking-tight sm:text-4xl">
                Ways to hang out
              </h2>
            </div>
            <p className="max-w-sm text-sm text-muted">Three ways to spend an evening together, wherever everyone is.</p>
          </div>

          <div className="grid gap-5 md:grid-cols-3">
            {EXPERIENCES.map((exp, i) => (
              <ExperienceCard
                key={exp.mode}
                experience={exp}
                index={i}
                busy={busy === (exp.mode === 'youtube' ? 'create' : exp.mode)}
                onStart={() => createRoom(exp.mode)}
                onNotify={() => toast(`We'll let you know when ${exp.title} launches 💜`)}
              />
            ))}
          </div>
        </section>

        {/* How it works */}
        <section className="mt-20 sm:mt-24" aria-labelledby="how-heading">
          <h2 id="how-heading" className="mb-8 text-center text-3xl font-extrabold tracking-tight sm:text-4xl">
            Three steps to the couch
          </h2>
          <ol className="grid gap-5 md:grid-cols-3">
            {STEPS.map(({ icon: Icon, title, text }, i) => (
              <motion.li
                key={title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: '-60px' }}
                transition={{ delay: i * 0.1 }}
                className="glass relative rounded-3xl p-6"
              >
                <span className="absolute right-5 top-4 text-5xl font-black text-line/[0.07]" aria-hidden>
                  {i + 1}
                </span>
                <span className="mb-4 grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-violet-500/20 to-pink-500/20 ring-1 ring-fuchsia-400/30">
                  <Icon className="h-5 w-5 text-fuchsia-600 dark:text-fuchsia-300" aria-hidden />
                </span>
                <h3 className="font-bold">{title}</h3>
                <p className="mt-1.5 text-sm text-muted">{text}</p>
              </motion.li>
            ))}
          </ol>
        </section>

        <footer className="mt-20 flex flex-col items-center gap-2 border-t border-line/10 pt-8 text-center text-sm text-muted">
          <Logo />
          <p className="flex items-center gap-1.5">
            <MessageCircle className="h-4 w-4" aria-hidden /> Made for cozy nights in, wherever your friends are.
          </p>
        </footer>
      </main>
    </motion.div>
  );
}

interface ExperienceCardProps {
  experience: Experience;
  index: number;
  busy: boolean;
  onStart: () => void;
  onNotify: () => void;
}

function ExperienceCard({ experience: exp, index, busy, onStart, onNotify }: ExperienceCardProps) {
  const Icon = exp.icon;
  return (
    <motion.article
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ delay: index * 0.08 }}
      whileHover={{ y: -6 }}
      className={`glass group relative flex flex-col overflow-hidden rounded-3xl p-6 ${exp.available ? 'ring-1 ring-rose-400/30' : ''}`}
    >
      {/* Soft color wash in the card's brand color */}
      <div
        className={`pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-gradient-to-br ${exp.gradient} opacity-20 blur-3xl transition-opacity group-hover:opacity-30`}
        aria-hidden
      />

      <div className="relative mb-5 flex items-start justify-between">
        <span className={`grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br ${exp.gradient} shadow-lg ${exp.glow}`}>
          <Icon className="h-7 w-7 text-white" aria-hidden />
        </span>
        {exp.available ? (
          <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden /> Available now
          </span>
        ) : (
          <span className="rounded-full border border-line/15 bg-line/5 px-2.5 py-1 text-xs font-semibold text-muted">Coming soon</span>
        )}
      </div>

      <h3 className="relative text-xl font-extrabold tracking-tight">{exp.title}</h3>
      <p className="relative mt-2 text-sm text-muted">{exp.tagline}</p>

      <ul className="relative mt-5 flex flex-col gap-2 text-sm">
        {exp.features.map((f) => (
          <li key={f} className={`flex items-center gap-2 ${exp.available ? '' : 'text-muted'}`}>
            <Check className={`h-4 w-4 shrink-0 ${exp.available ? 'text-emerald-500' : 'text-muted/60'}`} aria-hidden />
            {f}
          </li>
        ))}
      </ul>

      <div className="relative mt-auto pt-6">
        {exp.available ? (
          <button type="button" onClick={onStart} disabled={busy} className={`btn w-full bg-gradient-to-r py-3 text-sm text-white shadow-lg hover:brightness-110 ${exp.gradient} ${exp.glow}`}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PartyPopper className="h-4 w-4" aria-hidden />}
            {{ youtube: 'Start a watch party', music: 'Start a music party', movies: 'Start a movie night' }[exp.mode]}
          </button>
        ) : (
          <button type="button" onClick={onNotify} className="btn-ghost w-full py-3 text-sm">
            <Bell className="h-4 w-4" aria-hidden /> Notify me
          </button>
        )}
      </div>
    </motion.article>
  );
}

function FadeUp({ delay, children }: { delay: number; children: React.ReactNode }) {
  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }}>
      {children}
    </motion.div>
  );
}

function AnimatedBackground() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <motion.div
        className="absolute -left-32 -top-32 h-[28rem] w-[28rem] rounded-full bg-violet-600/30 blur-3xl dark:bg-violet-600/25"
        animate={{ x: [0, 80, 0], y: [0, 60, 0] }}
        transition={{ duration: 18, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -right-24 top-40 h-[26rem] w-[26rem] rounded-full bg-pink-500/25 blur-3xl dark:bg-pink-600/20"
        animate={{ x: [0, -70, 0], y: [0, 80, 0] }}
        transition={{ duration: 22, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute left-1/3 top-[42rem] h-[24rem] w-[24rem] rounded-full bg-indigo-500/20 blur-3xl"
        animate={{ x: [0, 60, -40, 0], y: [0, -50, 0] }}
        transition={{ duration: 26, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(rgb(var(--c-line)/0.07)_1px,transparent_1px)] [background-size:24px_24px] [mask-image:linear-gradient(to_bottom,black_0%,transparent_60%)]" />
    </div>
  );
}
