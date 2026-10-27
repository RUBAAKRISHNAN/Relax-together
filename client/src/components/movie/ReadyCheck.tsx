import { AlertTriangle, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import type { Member, MovieReadyState } from '@shared/types';
import { Avatar } from '../Avatar';

const STATES: Record<MovieReadyState | 'unknown', { label: string; icon: typeof CheckCircle2; className: string }> = {
  ready: { label: 'Ready', icon: CheckCircle2, className: 'text-emerald-500' },
  mismatch: { label: 'Different version', icon: AlertTriangle, className: 'text-amber-500' },
  missing: { label: 'Opening the movie…', icon: CircleDashed, className: 'text-muted' },
  error: { label: "Can't play it", icon: XCircle, className: 'text-red-500' },
  unknown: { label: 'Getting ready…', icon: CircleDashed, className: 'text-muted' },
};

interface ReadyCheckProps {
  members: Member[];
  ready: Record<string, MovieReadyState>;
  hostId: string | null;
  selfId: string;
  isHost: boolean;
  playing: boolean;
}

/** Who's set for the movie, so the host knows when to press play. */
export function ReadyCheck({ members, ready, hostId, selfId, isHost, playing }: ReadyCheckProps) {
  const online = members.filter((m) => m.online);
  const readyCount = online.filter((m) => ready[m.id] === 'ready' || ready[m.id] === 'mismatch').length;
  const allReady = readyCount === online.length;

  return (
    <div className="glass flex flex-col gap-3 rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Ready check</h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            allReady ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-line/10 text-muted'
          }`}
        >
          {readyCount}/{online.length} ready
        </span>
      </div>
      <ul className="flex flex-col gap-2">
        {online.map((m) => {
          const state = STATES[ready[m.id] ?? 'unknown'];
          return (
            <li key={m.id} className="flex items-center gap-2.5 text-sm">
              <Avatar name={m.name} color={m.color} size="sm" />
              <span className="min-w-0 flex-1 truncate">
                {m.name}
                {m.id === selfId && <span className="text-muted"> (you)</span>}
                {m.id === hostId && <span className="text-muted"> · host</span>}
              </span>
              <span className={`flex shrink-0 items-center gap-1 text-xs font-medium ${state.className}`}>
                <state.icon className="h-4 w-4" aria-hidden /> {state.label}
              </span>
            </li>
          );
        })}
      </ul>
      {isHost && !playing && (
        <p className="text-xs text-muted">{allReady ? 'Everyone is set. Press play when you are! 🎬' : 'You can start anytime; latecomers jump straight in.'}</p>
      )}
    </div>
  );
}
