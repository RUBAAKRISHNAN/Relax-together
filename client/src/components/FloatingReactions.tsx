import { AnimatePresence, motion } from 'framer-motion';
import type { FloatingReaction } from '../hooks/useRoomSession';

export function FloatingReactions({ items }: { items: FloatingReaction[] }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden>
      <AnimatePresence>
        {items.map((r) => (
          <motion.div
            key={r.id}
            className="absolute bottom-4 flex flex-col items-center"
            style={{ left: `${r.x}%` }}
            initial={{ y: 20, opacity: 0, scale: 0.5 }}
            animate={{ y: -220, opacity: [0, 1, 1, 0], scale: [0.5, 1.25, 1, 0.9], x: [0, 12, -12, 6] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 2.6, ease: 'easeOut' }}
          >
            <span className="text-4xl drop-shadow-lg sm:text-5xl">{r.emoji}</span>
            <span className="mt-1 max-w-[7rem] truncate rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">{r.name}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
