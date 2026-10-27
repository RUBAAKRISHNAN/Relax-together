import { AnimatePresence, motion } from 'framer-motion';
import type { VideoMeta } from '@shared/types';

export function NowPlaying({ video, isLive }: { video: VideoMeta | null; isLive: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <AnimatePresence mode="wait" initial={false}>
        {video ? (
          <motion.div
            key={video.videoId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="flex min-w-0 items-center gap-3"
          >
            <img src={video.thumbnail} alt="" className="aspect-video h-11 shrink-0 rounded-lg object-cover ring-1 ring-line/10" loading="lazy" />
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
                Now playing
                {isLive && (
                  <span className="flex items-center gap-1 rounded bg-red-600 px-1.5 py-px text-[10px] font-bold tracking-wide text-white">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" aria-hidden /> LIVE
                  </span>
                )}
              </p>
              <p className="truncate text-sm font-semibold" title={video.title}>
                {video.title}
              </p>
              {video.author && <p className="truncate text-xs text-muted">{video.author}</p>}
            </div>
          </motion.div>
        ) : (
          <motion.p key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-sm text-muted">
            Nothing playing yet
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
