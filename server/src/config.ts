import 'dotenv/config';

export const PORT = Number(process.env.PORT) || 3001;
export const IS_PROD = process.env.NODE_ENV === 'production';

/** Comma-separated list of allowed browser origins. */
export const CLIENT_URLS = (process.env.CLIENT_URL ?? 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** In development any origin is allowed so the app can be opened from a phone on the LAN. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (!IS_PROD) return true;
  return CLIENT_URLS.includes(origin.replace(/\/$/, ''));
}
