import { motion } from 'framer-motion';
import { REACTION_EMOJIS, type ReactionEmoji } from '@shared/constants';

const LABELS: Record<ReactionEmoji, string> = {
  '❤️': 'Love',
  '😂': 'Laugh',
  '🔥': 'Fire',
  '😮': 'Wow',
  '👏': 'Applause',
};

export function ReactionBar({ onReact }: { onReact: (emoji: ReactionEmoji) => void }) {
  return (
    <div className="glass flex items-center gap-0.5 rounded-full p-1" role="group" aria-label="Send a reaction">
      {REACTION_EMOJIS.map((emoji) => (
        <motion.button
          key={emoji}
          type="button"
          whileHover={{ scale: 1.2, y: -2 }}
          whileTap={{ scale: 0.85 }}
          onClick={() => onReact(emoji)}
          className="focus-ring grid h-9 w-9 place-items-center rounded-full text-xl transition-colors hover:bg-line/10 sm:h-10 sm:w-10"
          aria-label={`React with ${LABELS[emoji]}`}
          title={LABELS[emoji]}
        >
          {emoji}
        </motion.button>
      ))}
    </div>
  );
}
