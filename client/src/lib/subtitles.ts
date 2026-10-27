export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** "00:01:02,345" (SRT) or "01:02.345" / "00:01:02.345" (WebVTT) → seconds. */
function parseTimestamp(value: string): number {
  const m = value.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** Parses SRT or WebVTT into cues sorted by start time. Styling tags are dropped. */
export function parseSubtitles(raw: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timing = lines.findIndex((l) => l.includes('-->'));
    if (timing < 0) continue;
    const [from, to] = lines[timing].split('-->');
    const start = parseTimestamp(from);
    const end = parseTimestamp(to.trim().split(/\s+/)[0]);
    const text = lines
      .slice(timing + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\{\\[^}]*\}/g, '')
      .trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text) cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** The cue showing at time `t` (binary search; cues are sorted by start). */
export function cueAt(cues: Cue[], t: number): Cue | null {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // Overlapping cues are rare; check a couple back in case a long cue is still on screen.
  for (let i = found; i >= 0 && i >= found - 2; i--) if (cues[i].end > t) return cues[i];
  return null;
}

/**
 * Subtitle files come in many encodings: UTF-8, UTF-16 (with BOM) and, very often, Windows-1252.
 * Try them in that order so accents and non-Latin scripts display correctly.
 */
export async function readSubtitleFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
