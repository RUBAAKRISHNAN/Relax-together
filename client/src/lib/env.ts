const configured = (import.meta.env.VITE_SERVER_URL as string | undefined)?.trim().replace(/\/$/, '');

/** Server origin. In dev it defaults to port 3001 on whatever host served the page (works over LAN too). */
export const SERVER_URL =
  configured || (import.meta.env.DEV ? `${location.protocol}//${location.hostname}:3001` : location.origin);
