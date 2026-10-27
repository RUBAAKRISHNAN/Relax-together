import { AnimatePresence, motion } from 'framer-motion';
import { Crown } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Member } from '@shared/types';
import { Avatar } from './Avatar';
import { useToast } from './Toasts';

interface PeoplePanelProps {
  members: Member[];
  hostId: string | null;
  selfId: string;
  isHost: boolean;
  onTransfer: (userId: string) => Promise<string | null>;
}

export function PeoplePanel({ members, hostId, selfId, isHost, onTransfer }: PeoplePanelProps) {
  const toast = useToast();
  const [confirming, setConfirming] = useState<string | null>(null);

  // Two-step confirm resets itself after a few seconds.
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(null), 4000);
    return () => clearTimeout(t);
  }, [confirming]);

  const sorted = [...members].sort((a, b) => (a.id === hostId ? -1 : b.id === hostId ? 1 : a.joinedAt - b.joinedAt));
  const online = members.filter((m) => m.online).length;

  const transfer = async (m: Member) => {
    if (confirming !== m.id) {
      setConfirming(m.id);
      return;
    }
    setConfirming(null);
    const err = await onTransfer(m.id);
    if (err) toast(err, 'error');
  };

  return (
    <div className="scrollbar-thin flex-1 overflow-y-auto p-3">
      <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {online} watching{members.length > online ? ` · ${members.length - online} reconnecting` : ''}
      </p>
      <ul className="flex flex-col gap-1">
        <AnimatePresence initial={false}>
          {sorted.map((m) => {
            const host = m.id === hostId;
            const me = m.id === selfId;
            return (
              <motion.li
                key={m.id}
                layout
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 10 }}
                className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-line/5"
              >
                <Avatar name={m.name} color={m.color} online={m.online} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                    <span className="truncate">{m.name}</span>
                    {me && <span className="shrink-0 rounded-md bg-line/10 px-1.5 py-0.5 text-[10px] font-semibold text-muted">YOU</span>}
                    {host && <Crown className="h-4 w-4 shrink-0 fill-amber-400 text-amber-500" aria-label="Host" />}
                  </p>
                  <p className="text-xs text-muted">{host ? 'Host' : m.online ? 'Watching' : 'Reconnecting…'}</p>
                </div>
                {isHost && !me && m.online && (
                  <button
                    type="button"
                    onClick={() => transfer(m)}
                    className={`focus-ring flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                      confirming === m.id
                        ? 'bg-amber-500 text-black'
                        : 'border border-line/10 text-muted hover:border-amber-400/50 hover:text-fg'
                    }`}
                    aria-label={confirming === m.id ? `Confirm making ${m.name} the host` : `Make ${m.name} the host`}
                  >
                    <Crown className="h-3.5 w-3.5" aria-hidden />
                    {confirming === m.id ? 'Confirm?' : 'Make host'}
                  </button>
                )}
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {members.length === 1 && (
        <p className="mt-6 px-4 text-center text-sm text-muted">It's just you so far. Use the Invite button to bring friends along 🎟️</p>
      )}
    </div>
  );
}
