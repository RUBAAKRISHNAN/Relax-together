import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { normalizeRoomCode } from '@shared/constants';
import { Home } from './components/Home';
import { Room } from './components/Room';

function roomFromPath(): string | null {
  const match = window.location.pathname.match(/^\/room\/([^/]+)\/?$/);
  return match ? normalizeRoomCode(match[1]) : null;
}

/**
 * Tiny router: "/" is the home dashboard, "/room/CODE" a room. Opening an invite link shows the
 * home card first on purpose: that click counts as a user gesture, so the video can
 * autoplay with sound when we enter the room.
 */
export default function App() {
  const [pathRoom, setPathRoom] = useState(roomFromPath);
  const [active, setActive] = useState<{ roomId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPop = () => {
      setPathRoom(roomFromPath());
      setActive(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const enter = useCallback((roomId: string, name: string) => {
    if (window.location.pathname !== `/room/${roomId}`) window.history.pushState(null, '', `/room/${roomId}`);
    setPathRoom(roomId);
    setError(null);
    setActive({ roomId, name });
  }, []);

  const leave = useCallback((reason?: string) => {
    window.history.pushState(null, '', '/');
    setPathRoom(null);
    setActive(null);
    setError(reason ?? null);
  }, []);

  useEffect(() => {
    document.title = active ? `Room ${active.roomId} · Relax Together` : 'Relax Together: watch with friends, in sync';
  }, [active]);

  return (
    <AnimatePresence mode="wait">
      {active ? (
        <Room key={active.roomId} roomId={active.roomId} name={active.name} onLeave={leave} />
      ) : (
        <Home key="home" inviteCode={pathRoom} error={error} onEnter={enter} />
      )}
    </AnimatePresence>
  );
}
