import { io, type Socket } from 'socket.io-client';
import type { AckResponse, ClientToServerEvents, ServerToClientEvents } from '@shared/types';
import { SERVER_URL } from './env';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocket(): AppSocket {
  return io(SERVER_URL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000,
    timeout: 8000,
  });
}

/** Emits an event that takes an ack and resolves with its response (or a timeout error). */
export function request<T = null>(
  socket: AppSocket,
  event: keyof ClientToServerEvents,
  ...payload: unknown[]
): Promise<AckResponse<T>> {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve({ ok: false, error: "You're offline. Reconnecting…" });
      return;
    }
    (socket.timeout(8000) as unknown as { emit: (...args: unknown[]) => void }).emit(
      event,
      ...payload,
      (err: Error | null, res: AckResponse<T>) => {
        resolve(err ? { ok: false, error: 'The server took too long to respond.' } : res);
      },
    );
  });
}
