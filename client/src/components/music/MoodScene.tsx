import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef } from 'react';
import type { MoodId } from '@shared/constants';
import { moodById } from './moods';
import { SCENES, type Scene } from './scenes';

interface MoodSceneProps {
  mood: MoodId;
  playing: boolean;
  /** Per-person "Effects" switch; when off (or with reduced motion) the scene is a still frame. */
  animate: boolean;
  /** Live loudness 0..1 of the music, or null when it can't be measured. */
  getEnergy: () => number | null;
}

/** Ambient scenes look the same at 30 fps, and it leaves the CPU for decoding the music. */
const FRAME_MS = 1000 / 30;
/** Upper bound on canvas pixels; the soft scenes are scaled up by CSS without visible loss. */
const PIXEL_BUDGET = 1_000_000;
/** If drawing a frame takes longer than this on average, drop the resolution. */
const SLOW_FRAME_MS = 7;

/** Full-screen animated environment behind the music room. Crossfades when the mood changes. */
export function MoodScene(props: MoodSceneProps) {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden>
      <AnimatePresence initial={false}>
        <motion.div
          key={props.mood}
          className="absolute inset-0"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.2, ease: 'easeInOut' }}
          style={{ background: moodById(props.mood).background }}
        >
          <SceneCanvas {...props} />
        </motion.div>
      </AnimatePresence>
      {/* Gentle vignette keeps the glass UI readable on any scene. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.35)_100%)]" />
    </div>
  );
}

function SceneCanvas({ mood, playing, animate, getEnergy }: MoodSceneProps) {
  const backdropRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  // Read through refs so the animation loop never restarts when these change.
  const playingRef = useRef(playing);
  const energyRef = useRef(getEnergy);
  playingRef.current = playing;
  energyRef.current = getEnergy;

  useEffect(() => {
    const backdrop = backdropRef.current!;
    const live = liveRef.current!;
    const ctx = live.getContext('2d');
    if (!ctx) return;
    const still = !animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let scene: Scene;
    let w = 0;
    let h = 0;
    let scale = 1;
    let quality = 1;
    let raf = 0;
    const start = performance.now();
    let last = start;
    let lastDraw = 0;
    let energy = 0;
    let costSum = 0;
    let costFrames = 0;

    const setup = () => {
      w = window.innerWidth;
      h = window.innerHeight;
      scale = Math.min(window.devicePixelRatio || 1, 1, Math.sqrt(PIXEL_BUDGET / (w * h))) * quality;
      for (const c of [backdrop, live]) {
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
      }
      scene = SCENES[mood](w, h);
      const bctx = backdrop.getContext('2d')!;
      bctx.clearRect(0, 0, backdrop.width, backdrop.height);
      if (scene.backdrop) bctx.drawImage(scene.backdrop, 0, 0, backdrop.width, backdrop.height);
    };

    const render = (now: number, dt: number) => {
      const t = (now - start) / 1000;
      // Measured loudness when we have it; otherwise a soft synthetic pulse while music plays.
      const measured = energyRef.current();
      const target = measured ?? (playingRef.current ? 0.35 + 0.3 * Math.pow(Math.max(0, Math.sin(t * Math.PI * 2)), 6) : 0);
      energy += (target - energy) * Math.min(1, dt * 8);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, w, h);
      scene.draw(ctx, { w, h, t, dt, energy });
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - lastDraw < FRAME_MS - 2) return;
      lastDraw = now;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const before = performance.now();
      render(now, dt);
      // Adaptive quality: on a slow device, trade resolution for a light CPU footprint.
      costSum += performance.now() - before;
      if (++costFrames === 30) {
        if (costSum / costFrames > SLOW_FRAME_MS && quality > 0.5) {
          quality = Math.max(0.5, quality * 0.75);
          setup();
        }
        costSum = 0;
        costFrames = 0;
      }
    };

    const onResize = () => {
      setup();
      if (still) renderStill();
    };

    // A calm still frame, a few simulated seconds in so particles are spread out.
    function renderStill() {
      for (let i = 0; i < 40; i++) render(start + i * 100, 0.1);
    }

    setup();
    window.addEventListener('resize', onResize);
    if (still) renderStill();
    else raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [mood, animate]);

  return (
    <>
      <canvas ref={backdropRef} className="absolute inset-0 h-full w-full" />
      <canvas ref={liveRef} className="absolute inset-0 h-full w-full" />
    </>
  );
}
