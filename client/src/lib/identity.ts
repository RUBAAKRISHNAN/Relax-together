const USER_ID_KEY = 'wp:userId'; // storage keys keep the original prefix so saved names survive the rename
const NAME_KEY = 'wp:name';

function randomId(): string {
  // crypto.randomUUID needs a secure context; getRandomValues works on plain-http LAN addresses too.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: Storage, key: string, value: string) {
  try {
    storage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode etc.) */
  }
}

let memoryId: string | null = null;

/**
 * Per-tab identity (sessionStorage), so two windows are two people but a refresh or
 * reconnect keeps the same seat, including host status.
 */
export function getUserId(): string {
  const stored = safeGet(sessionStorage, USER_ID_KEY);
  if (stored) return stored;
  memoryId ??= randomId();
  safeSet(sessionStorage, USER_ID_KEY, memoryId);
  return memoryId;
}

export const getSavedName = () => safeGet(localStorage, NAME_KEY) ?? '';
export const saveName = (name: string) => safeSet(localStorage, NAME_KEY, name);
