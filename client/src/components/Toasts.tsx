import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Crown, Film, LogOut, UserPlus, type LucideIcon } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'success' | 'error' | 'join' | 'leave' | 'host' | 'video';

interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
}

const TONES: Record<ToastTone, { icon: LucideIcon; className: string }> = {
  success: { icon: CheckCircle2, className: 'text-emerald-500 dark:text-emerald-400' },
  error: { icon: AlertCircle, className: 'text-red-500 dark:text-red-400' },
  join: { icon: UserPlus, className: 'text-sky-500 dark:text-sky-400' },
  leave: { icon: LogOut, className: 'text-muted' },
  host: { icon: Crown, className: 'text-amber-500 dark:text-amber-400' },
  video: { icon: Film, className: 'text-fuchsia-500 dark:text-fuchsia-400' },
};

type ToastFn = (text: string, tone?: ToastTone) => void;
const ToastContext = createContext<ToastFn>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const toast = useCallback<ToastFn>(
    (text, tone = 'success') => {
      const id = nextId.current++;
      setToasts((t) => [...t.slice(-3), { id, text, tone }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 5000 : 3500);
    },
    [dismiss],
  );

  const value = useMemo(() => toast, [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 top-3 z-50 flex flex-col items-center gap-2 px-4 sm:bottom-5 sm:right-5 sm:top-auto sm:items-end"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const { icon: Icon, className } = TONES[t.tone];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: -12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
                className="glass pointer-events-auto flex max-w-sm items-center gap-3 rounded-2xl px-4 py-3 text-sm"
                role={t.tone === 'error' ? 'alert' : 'status'}
                onClick={() => dismiss(t.id)}
              >
                <Icon className={`h-5 w-5 shrink-0 ${className}`} aria-hidden />
                <span className="leading-snug">{t.text}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
