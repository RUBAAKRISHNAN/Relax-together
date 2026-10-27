/** Helpers for reading the JSON YouTube embeds in its public pages. */

export type Json = Record<string, unknown>;

export const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  // Skips the EU cookie-consent interstitial.
  Cookie: 'CONSENT=YES+1; SOCS=CAI',
};

export const isObj = (v: unknown): v is Json => !!v && typeof v === 'object';

export function get(obj: unknown, ...path: (string | number)[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = (cur as Json)[key as string];
  }
  return cur;
}

export const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** YouTube text is either { simpleText } or { runs: [{ text }] } (or { content } in view models). */
export function text(v: unknown): string {
  if (!isObj(v)) return str(v);
  if (typeof v.simpleText === 'string') return v.simpleText;
  if (typeof v.content === 'string') return v.content;
  if (Array.isArray(v.runs)) return v.runs.map((r) => str(get(r, 'text'))).join('');
  return '';
}

/** Visits every object under `root` in document order (pre-order, depth-first). */
export function walk(root: unknown, visit: (key: string, value: Json) => void) {
  const stack: [string, unknown][] = [['', root]];
  while (stack.length) {
    const [key, node] = stack.pop()!;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push([key, node[i]]);
    } else if (isObj(node)) {
      if (key) visit(key, node);
      const entries = Object.entries(node);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i];
        if (isObj(v) || Array.isArray(v)) stack.push([k, v]);
      }
    }
  }
}

/** Extracts a JSON object assigned in the page (`var ytInitialData = {...};`). */
export function extractJson(html: string, variable: string): unknown {
  const marker = `var ${variable} = `;
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const end = html.indexOf(';</script>', start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start + marker.length, end));
  } catch {
    // The player response is sometimes followed by more statements in the same script tag.
    const alt = html.indexOf(';var ', start);
    try {
      return alt > 0 ? JSON.parse(html.slice(start + marker.length, alt)) : null;
    } catch {
      return null;
    }
  }
}

/** "3:24" / "1:02:03" → seconds (0 when unparseable). */
export function parseClock(value: string | null | undefined): number {
  if (!value || !/^\d+(:\d{1,2})+$/.test(value.trim())) return 0;
  return value
    .trim()
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0);
}
