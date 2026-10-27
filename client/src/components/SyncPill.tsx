import { motion } from 'framer-motion';
import type { SyncStatus } from '../lib/syncEngine';

const CONFIG: Record<SyncStatus, { label: string; dot: string; className: string }> = {
  'in-sync': {
    label: 'In sync',
    dot: 'bg-emerald-400',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  },
  syncing: {
    label: 'Syncing…',
    dot: 'bg-amber-400',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  },
  reconnecting: {
    label: 'Reconnecting',
    dot: 'bg-red-500',
    className: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  },
};

export function SyncPill({ status, drift }: { status: SyncStatus; drift: number | null }) {
  const { label, dot, className } = CONFIG[status];
  const detail = drift === null ? '' : ` (${drift >= 0 ? '+' : ''}${Math.round(drift * 1000)} ms)`;
  return (
    <motion.div
      layout
      role="status"
      aria-live="polite"
      title={`Playback ${label.toLowerCase()}${detail}`}
      className={`flex items-center gap-2 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold ${className}`}
    >
      <span className="relative flex h-2 w-2">
        {status !== 'in-sync' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${dot}`} />}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      {label}
    </motion.div>
  );
}
