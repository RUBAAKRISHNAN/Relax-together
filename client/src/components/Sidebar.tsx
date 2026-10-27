import { AnimatePresence, motion } from 'framer-motion';
import { ListVideo, MessageCircle, Users, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ChatMessage, RoomSnapshot } from '@shared/types';
import type { RoomActions } from '../hooks/useRoomSession';
import type { SuggestionsState } from '../hooks/useSuggestions';
import type { UploadJob } from '../hooks/useUploads';
import { ChatPanel } from './ChatPanel';
import { PeoplePanel } from './PeoplePanel';
import { QueuePanel } from './QueuePanel';

type Tab = 'chat' | 'people' | 'queue';

interface SidebarProps {
  snapshot: RoomSnapshot;
  selfId: string;
  isHost: boolean;
  messages: ChatMessage[];
  suggestions: SuggestionsState;
  actions: RoomActions;
  uploads: UploadJob[];
  onUpload: (files: File[]) => void;
}

export function Sidebar({ snapshot, selfId, isHost, messages, suggestions, actions, uploads, onUpload }: SidebarProps) {
  const [tab, setTab] = useState<Tab>('chat');
  const [unread, setUnread] = useState(0);
  const seenCount = useRef(messages.length);
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ chat: null, people: null, queue: null });

  useEffect(() => {
    if (tab === 'chat') {
      seenCount.current = messages.length;
      setUnread(0);
    } else {
      setUnread(Math.max(0, messages.length - seenCount.current));
    }
  }, [messages.length, tab]);

  const online = snapshot.members.filter((m) => m.online).length;
  const tabs: { id: Tab; label: string; icon: LucideIcon; badge?: number; count?: number }[] = [
    { id: 'chat', label: 'Chat', icon: MessageCircle, badge: unread },
    { id: 'people', label: 'People', icon: Users, count: online },
  ];
  // A movie night has no queue.
  if (snapshot.mode !== 'movies') tabs.push({ id: 'queue', label: 'Up next', icon: ListVideo, count: snapshot.queue.length });

  // Arrow-key navigation between tabs (WAI-ARIA tabs pattern).
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const index = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(index + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    setTab(next);
    tabRefs.current[next]?.focus();
    e.preventDefault();
  };

  return (
    <aside className="glass flex min-h-[440px] flex-1 flex-col overflow-hidden rounded-2xl lg:min-h-0 lg:w-[380px] lg:flex-none xl:w-[400px]">
      <div
        role="tablist"
        aria-label="Room panels"
        onKeyDown={onTabKey}
        className="order-last flex shrink-0 gap-1 border-t border-line/10 p-1.5 lg:order-first lg:border-b lg:border-t-0"
      >
        {tabs.map(({ id, label, icon: Icon, badge, count }) => {
          const active = tab === id;
          return (
            <button
              key={id}
              ref={(el) => (tabRefs.current[id] = el)}
              role="tab"
              id={`tab-${id}`}
              aria-selected={active}
              aria-controls={`panel-${id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(id)}
              className={`focus-ring relative flex flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-2 text-xs font-semibold transition sm:flex-row sm:gap-2 sm:text-sm ${
                active ? 'text-fg' : 'text-muted hover:bg-line/5 hover:text-fg'
              }`}
            >
              {active && (
                <motion.span
                  layoutId="tab-highlight"
                  className="absolute inset-0 rounded-xl bg-gradient-to-r from-violet-500/15 to-pink-500/15 ring-1 ring-fuchsia-400/30"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              )}
              <Icon className="relative h-5 w-5 sm:h-4 sm:w-4" aria-hidden />
              <span className="relative">{label}</span>
              {count !== undefined && count > 0 && <span className="relative hidden text-muted sm:inline">{count}</span>}
              {!!badge && (
                <span className="absolute right-2 top-1 grid h-5 min-w-5 place-items-center rounded-full bg-pink-500 px-1 text-[10px] font-bold text-white sm:relative sm:right-auto sm:top-auto">
                  {badge > 99 ? '99+' : badge}
                  <span className="sr-only"> unread</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={tab}
            id={`panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 flex flex-col"
          >
            {tab === 'chat' && <ChatPanel messages={messages} selfId={selfId} onSend={actions.sendChat} />}
            {tab === 'people' && (
              <PeoplePanel members={snapshot.members} hostId={snapshot.hostId} selfId={selfId} isHost={isHost} onTransfer={actions.transferHost} />
            )}
            {tab === 'queue' && (
              <QueuePanel
                queue={snapshot.queue}
                selfId={selfId}
                isHost={isHost}
                autoplay={snapshot.autoplay}
                hasVideo={!!snapshot.video}
                currentVideoId={snapshot.video?.videoId ?? null}
                isMusic={snapshot.mode === 'music'}
                suggestions={suggestions}
                actions={actions}
                uploads={uploads}
                onUpload={onUpload}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </aside>
  );
}
