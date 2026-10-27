import { Captions, CaptionsOff, Minus, Plus, Share2, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SUBTITLE_MAX_CHARS } from '@shared/constants';
import type { SubtitleTrack } from '@shared/types';
import { type Cue, cueAt, parseSubtitles, readSubtitleFile } from '../../lib/subtitles';
import { useToast } from '../Toasts';

export type SubtitleSize = 'sm' | 'md' | 'lg';

export interface SubtitleSettings {
  enabled: boolean;
  size: SubtitleSize;
  /** Seconds added to the movie time when picking a cue (fixes subtitles that are early/late). */
  delay: number;
}

const SETTINGS_KEY = 'wp:subtitles';
const SIZES: Record<SubtitleSize, string> = {
  sm: 'text-sm sm:text-base',
  md: 'text-base sm:text-xl',
  lg: 'text-lg sm:text-3xl',
};

/** Per-person subtitle preferences, remembered in this browser. */
export function useSubtitleSettings() {
  const [settings, setSettings] = useState<SubtitleSettings>(() => {
    try {
      return { enabled: true, size: 'md', delay: 0, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    } catch {
      return { enabled: true, size: 'md', delay: 0 };
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, delay: 0 }));
    } catch {
      /* ignore */
    }
  }, [settings]);
  return [settings, setSettings] as const;
}

/** Renders the cue for the current movie time on top of the picture. */
export function SubtitleOverlay({ cues, getTime, settings }: { cues: Cue[]; getTime: () => number; settings: SubtitleSettings }) {
  const [text, setText] = useState<string | null>(null);
  const getTimeRef = useRef(getTime);
  getTimeRef.current = getTime;

  useEffect(() => {
    if (!settings.enabled || !cues.length) {
      setText(null);
      return;
    }
    // 10 updates a second is plenty for subtitles and keeps re-renders rare (only when text changes).
    const timer = setInterval(() => setText(cueAt(cues, getTimeRef.current() - settings.delay)?.text ?? null), 100);
    return () => clearInterval(timer);
  }, [cues, settings.enabled, settings.delay]);

  if (!text) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[7%] z-10 flex justify-center px-6" aria-live="off">
      <p
        className={`max-w-[90%] whitespace-pre-line rounded-md bg-black/65 px-3 py-1 text-center font-semibold leading-snug text-white [text-shadow:0_1px_2px_#000] ${SIZES[settings.size]}`}
      >
        {text}
      </p>
    </div>
  );
}

interface SubtitlePanelProps {
  isHost: boolean;
  shared: SubtitleTrack | null;
  personal: SubtitleTrack | null;
  onPersonal: (track: SubtitleTrack | null) => void;
  onShare: (track: SubtitleTrack | null) => Promise<string | null>;
  settings: SubtitleSettings;
  onSettings: (s: SubtitleSettings) => void;
}

/** Subtitle controls: the host can share a file with everyone; anyone can use their own. */
export function SubtitlePanel({ isHost, shared, personal, onPersonal, onShare, settings, onSettings }: SubtitlePanelProps) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState<'share' | 'personal'>('personal');
  const active = personal ?? shared;

  const open = (mode: 'share' | 'personal') => {
    setTarget(mode);
    fileRef.current?.click();
  };

  const load = async (file: File) => {
    const text = await readSubtitleFile(file);
    if (text.length > SUBTITLE_MAX_CHARS) return toast('That subtitle file is too large.', 'error');
    if (!parseSubtitles(text).length) return toast("That doesn't look like an SRT or VTT subtitle file.", 'error');
    const track = { name: file.name, text };
    if (target === 'share') {
      const err = await onShare(track);
      toast(err ?? 'Subtitles shared with everyone', err ? 'error' : 'success');
    } else {
      onPersonal(track);
      toast('Using your subtitles (only you see these)');
    }
  };

  const nudge = (delta: number) => onSettings({ ...settings, delay: Math.round((settings.delay + delta) * 10) / 10 });

  return (
    <div className="glass flex flex-col gap-3 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Captions className="h-4 w-4 text-amber-500" aria-hidden /> Subtitles
        </h3>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => onSettings({ ...settings, enabled: !settings.enabled })}
          className={`focus-ring flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
            settings.enabled ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-line/10 text-muted'
          }`}
        >
          {settings.enabled ? <Captions className="h-3.5 w-3.5" aria-hidden /> : <CaptionsOff className="h-3.5 w-3.5" aria-hidden />}
          {settings.enabled ? 'On' : 'Off'}
        </button>
      </div>

      <p className="truncate text-xs text-muted">
        {active ? (
          <>
            Showing <span className="font-medium text-fg">{active.name}</span> {personal ? '(yours)' : '(shared by the host)'}
          </>
        ) : (
          'No subtitles loaded.'
        )}
      </p>

      <div className="flex flex-wrap gap-2">
        {isHost && (
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => open('share')}>
            <Share2 className="h-3.5 w-3.5" aria-hidden /> Share with everyone
          </button>
        )}
        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => open('personal')}>
          <Upload className="h-3.5 w-3.5" aria-hidden /> Use my own
        </button>
        {personal && (
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onPersonal(null)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Drop mine
          </button>
        )}
        {isHost && shared && (
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void onShare(null)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Unshare
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <div className="flex items-center gap-1" role="radiogroup" aria-label="Subtitle size">
          {(['sm', 'md', 'lg'] as SubtitleSize[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={settings.size === s}
              onClick={() => onSettings({ ...settings, size: s })}
              className={`focus-ring grid h-7 w-7 place-items-center rounded-lg font-bold ${settings.size === s ? 'bg-amber-500 text-black' : 'bg-line/10'}`}
              aria-label={{ sm: 'Small', md: 'Medium', lg: 'Large' }[s]}
            >
              <span className={{ sm: 'text-[10px]', md: 'text-xs', lg: 'text-sm' }[s]}>A</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5" title="Shift subtitles if they appear too early or too late">
          <span className="text-muted">Timing</span>
          <button type="button" className="icon-btn h-7 w-7" onClick={() => nudge(-0.5)} aria-label="Subtitles earlier">
            <Minus className="h-3.5 w-3.5" aria-hidden />
          </button>
          <span className="w-12 text-center tabular-nums">{settings.delay > 0 ? '+' : ''}{settings.delay.toFixed(1)}s</span>
          <button type="button" className="icon-btn h-7 w-7" onClick={() => nudge(0.5)} aria-label="Subtitles later">
            <Plus className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".srt,.vtt,text/vtt"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void load(file);
        }}
      />
    </div>
  );
}
