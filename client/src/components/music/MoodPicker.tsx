import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';
import type { MoodId } from '@shared/constants';
import { MOODS } from './moods';

interface MoodPickerProps {
  mood: MoodId;
  canChange: boolean;
  onChange: (mood: MoodId) => void;
  /** This person's own animation preference (not shared). */
  effects: boolean;
  onEffectsChange: (on: boolean) => void;
}

/** The host sets the room's environment; everyone else sees which one is on. */
export function MoodPicker({ mood, canChange, onChange, effects, onEffectsChange }: MoodPickerProps) {
  return (
    <div className="glass rounded-2xl p-3">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted">
          Set the mood
          {!canChange && <span className="ml-2 font-normal normal-case tracking-normal">· the host picks the vibe</span>}
        </p>
        <button
          type="button"
          role="switch"
          aria-checked={effects}
          onClick={() => onEffectsChange(!effects)}
          className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
            effects ? 'bg-fuchsia-500/15 text-fuchsia-700 dark:text-fuchsia-300' : 'bg-line/10 text-muted'
          }`}
          title="Animated scenery on this device only. Turn off on slower phones."
        >
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Effects {effects ? 'on' : 'off'}
        </button>
      </div>
      <div className="scrollbar-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible" role="radiogroup" aria-label="Room mood">
        {MOODS.map((m) => {
          const active = m.id === mood;
          return (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!canChange && !active}
              onClick={() => canChange && !active && onChange(m.id)}
              className={`focus-ring relative flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition ${
                active ? 'text-white' : 'bg-line/5 hover:bg-line/10 disabled:opacity-50'
              } ${canChange ? '' : 'cursor-default'}`}
              title={canChange ? `${m.name} (${m.vibe})` : m.name}
            >
              {active && (
                <motion.span
                  layoutId="mood-active"
                  className="absolute inset-0 rounded-xl"
                  style={{ background: m.background, boxShadow: `0 0 0 2px ${m.accent}, 0 6px 20px -6px ${m.accent}` }}
                  transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                />
              )}
              <span className="relative text-lg leading-none" aria-hidden>
                {m.emoji}
              </span>
              <span className={`relative leading-tight ${active ? '[text-shadow:0_1px_3px_rgba(0,0,0,0.6)]' : ''}`}>
                <span className="block font-semibold">{m.name}</span>
                <span className={`block text-[11px] ${active ? 'text-white/85' : 'text-muted'}`}>{m.vibe}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
