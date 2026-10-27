import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Controls fade out after this long without a touch, mouse move or key press. */
const HIDE_AFTER_MS = 3000;

type WebkitDocument = Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };
type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void> };

const fullscreenElement = () => document.fullscreenElement ?? (document as WebkitDocument).webkitFullscreenElement ?? null;

/**
 * Full screen for the player on every device, with controls that hide while you watch.
 *  - Uses the Fullscreen API (and Safari's webkit prefix); on phones it also asks for landscape.
 *  - iPhones only allow full screen for a bare <video> (which would lose our synced overlays),
 *    so there it falls back to a CSS full-window mode.
 *  - While full screen and playing, controls hide after 3 s without activity; any touch, mouse
 *    move or key brings them back. When paused they stay visible.
 */
export function useImmersive(targetRef: RefObject<HTMLElement>, playing: boolean) {
  const [native, setNative] = useState(false);
  const [pseudo, setPseudo] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const visibleRef = useRef(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const active = native || pseudo;

  useEffect(() => {
    const onChange = () => setNative(!!targetRef.current && fullscreenElement() === targetRef.current);
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, [targetRef]);

  const show = useCallback(
    (visible: boolean) => {
      visibleRef.current = visible;
      setControlsVisible(visible);
    },
    [],
  );

  /** Activity: show the controls and restart the 3 s countdown. */
  const poke = useCallback(() => {
    show(true);
    if (timer.current) clearTimeout(timer.current);
    if (active && playing) timer.current = setTimeout(() => show(false), HIDE_AFTER_MS);
  }, [active, playing, show]);

  // Entering/leaving full screen or play/pause restarts the countdown (or pins the controls).
  useEffect(() => {
    poke();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [poke]);

  useEffect(() => {
    const el = targetRef.current;
    if (!el || !active) return;
    const events = ['pointermove', 'pointerdown', 'touchstart', 'wheel'] as const;
    events.forEach((e) => el.addEventListener(e, poke, { passive: true }));
    // Keys go to whatever has focus (often outside the player), so listen on the window.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit();
      else poke();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      events.forEach((e) => el.removeEventListener(e, poke));
      window.removeEventListener('keydown', onKey);
    };
    // exit is stable enough: it only reads refs and setters.
  }, [targetRef, active, poke]);

  // CSS fallback: stop the page scrolling underneath.
  useEffect(() => {
    if (!pseudo) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [pseudo]);

  function exit() {
    setPseudo(false);
    if (fullscreenElement()) {
      (screen.orientation as LockableOrientation | undefined)?.unlock?.();
      void (document.exitFullscreen?.() ?? (document as WebkitDocument).webkitExitFullscreen?.())?.catch?.(() => {});
    }
  }

  const toggle = useCallback(() => {
    const el = targetRef.current as WebkitElement | null;
    if (!el) return;
    if (pseudo || fullscreenElement()) return exit();
    if (el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' })
        .then(() => (screen.orientation as LockableOrientation | undefined)?.lock?.('landscape').catch(() => {}))
        .catch(() => setPseudo(true));
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    } else {
      setPseudo(true);
    }
  }, [targetRef, pseudo]);

  return {
    /** Full screen (real or the CSS fallback). */
    active,
    /** True for the CSS fallback, which needs fixed positioning. */
    pseudo,
    toggle,
    controlsVisible,
    /** Whether the controls were visible a moment ago; used so a tap that reveals them doesn't also act. */
    visibleRef,
    poke,
  };
}
