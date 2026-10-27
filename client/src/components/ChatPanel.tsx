import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, Loader2, MessageCircle, SendHorizontal, Smile } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { MAX_CHAT_LENGTH } from '@shared/constants';
import type { ChatMessage } from '@shared/types';
import { formatClock } from '../lib/format';
import { Avatar } from './Avatar';

const EMOJIS = ['😀', '😂', '🤣', '😍', '🥹', '😎', '🤔', '😮', '😭', '😡', '👍', '👎', '👏', '🙌', '🔥', '❤️', '💯', '🎉', '🍿', '🎬', '👀', '💀', '✨', '🤯'];
/** Messages from the same person within this window are grouped under one header. */
const GROUP_WINDOW_MS = 2 * 60 * 1000;

interface ChatPanelProps {
  messages: ChatMessage[];
  selfId: string;
  onSend: (text: string) => Promise<string | null>;
}

export function ChatPanel({ messages, selfId, onSend }: ChatPanelProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const atBottom = useRef(true);
  const lastCount = useRef(messages.length);

  const scrollToBottom = (smooth: boolean) => {
    const el = listRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setUnseen(0);
  };

  useLayoutEffect(() => scrollToBottom(false), []);

  // Auto-scroll only when the reader is already at the bottom (or sent the message themselves).
  useEffect(() => {
    const added = messages.length - lastCount.current;
    lastCount.current = messages.length;
    if (added <= 0) return;
    const mine = messages[messages.length - 1]?.userId === selfId;
    if (atBottom.current || mine) scrollToBottom(true);
    else setUnseen((n) => n + added);
  }, [messages, selfId]);

  const onScroll = () => {
    const el = listRef.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (atBottom.current) setUnseen(0);
  };

  const length = Array.from(draft).length;
  const tooLong = length > MAX_CHAT_LENGTH;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || tooLong || sending) return;
    setSending(true);
    const err = await onSend(text);
    setSending(false);
    setError(err);
    if (!err) setDraft('');
    inputRef.current?.focus();
  };

  const insertEmoji = (emoji: string) => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    setDraft(draft.slice(0, start) + emoji + draft.slice(end));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  return (
    <>
      <div ref={listRef} onScroll={onScroll} className="scrollbar-thin flex-1 overflow-y-auto px-3 py-3" role="log" aria-label="Chat messages" aria-live="polite">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <MessageCircle className="h-10 w-10 opacity-40" aria-hidden />
            <p className="font-semibold text-fg">No messages yet</p>
            <p className="text-sm">Say hi and get the party started 👋</p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const grouped = prev?.userId === m.userId && m.sentAt - prev.sentAt < GROUP_WINDOW_MS;
              const mine = m.userId === selfId;
              return (
                <motion.li
                  key={m.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex gap-2.5 ${grouped ? 'mt-1' : 'mt-3 first:mt-0'} ${mine ? 'flex-row-reverse' : ''}`}
                >
                  <div className="w-8 shrink-0">{!grouped && <Avatar name={m.name} color={m.color} size="sm" />}</div>
                  <div className={`flex min-w-0 max-w-[80%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
                    {!grouped && (
                      <div className={`mb-1 flex items-baseline gap-2 text-xs ${mine ? 'flex-row-reverse' : ''}`}>
                        <span className="font-semibold">{mine ? 'You' : m.name}</span>
                        <time className="text-muted" dateTime={new Date(m.sentAt).toISOString()}>
                          {formatClock(m.sentAt)}
                        </time>
                      </div>
                    )}
                    <p
                      className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                        mine ? 'rounded-tr-md bg-gradient-to-br from-violet-600 to-pink-600 text-white' : 'rounded-tl-md bg-line/[0.07]'
                      }`}
                      title={formatClock(m.sentAt)}
                    >
                      {m.text}
                    </p>
                  </div>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>

      <AnimatePresence>
        {unseen > 0 && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => scrollToBottom(true)}
            className="focus-ring absolute bottom-20 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-fuchsia-600 px-3 py-1.5 text-xs font-semibold text-white shadow-lg"
          >
            <ArrowDown className="h-3.5 w-3.5" aria-hidden /> {unseen} new message{unseen > 1 ? 's' : ''}
          </motion.button>
        )}
      </AnimatePresence>

      <form onSubmit={submit} className="relative shrink-0 border-t border-line/10 p-2.5">
        <AnimatePresence>
          {pickerOpen && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              className="glass absolute bottom-full left-2.5 right-2.5 mb-2 grid grid-cols-8 gap-1 rounded-2xl bg-card/95 p-2"
              role="dialog"
              aria-label="Emoji picker"
              onKeyDown={(e) => e.key === 'Escape' && setPickerOpen(false)}
            >
              {EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => insertEmoji(emoji)}
                  className="focus-ring grid aspect-square place-items-center rounded-lg text-xl transition hover:scale-110 hover:bg-line/10"
                  aria-label={`Insert ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={`icon-btn ${pickerOpen ? 'bg-line/10 text-fg' : ''}`}
            onClick={() => setPickerOpen((o) => !o)}
            aria-label="Emoji"
            aria-expanded={pickerOpen}
          >
            <Smile className="h-5 w-5" aria-hidden />
          </button>
          <label htmlFor="chat-input" className="sr-only">
            Message
          </label>
          <input
            id="chat-input"
            ref={inputRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError(null);
            }}
            onFocus={() => setPickerOpen(false)}
            placeholder="Send a message…"
            autoComplete="off"
            className="input min-w-0 flex-1 rounded-full py-2.5 text-sm"
            aria-invalid={tooLong || !!error}
            aria-describedby="chat-hint"
          />
          <button
            type="submit"
            className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-br from-violet-600 to-pink-600 text-white shadow-md transition hover:brightness-110 active:scale-95 disabled:opacity-40"
            disabled={!draft.trim() || tooLong || sending}
            aria-label="Send message"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <SendHorizontal className="h-4 w-4" aria-hidden />}
          </button>
        </div>
        <p id="chat-hint" className={`px-2 pt-1 text-xs ${error || tooLong ? 'text-red-600 dark:text-red-400' : 'text-muted'} ${error || length > MAX_CHAT_LENGTH - 100 ? '' : 'sr-only'}`} role={error ? 'alert' : undefined}>
          {error ?? `${length}/${MAX_CHAT_LENGTH}`}
        </p>
      </form>
    </>
  );
}
