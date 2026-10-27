/**
 * Audio-language switching for movies people open from their own device.
 *
 * Chrome and Firefox can't switch a file's audio track from a web page (`audioTracks` is Safari-only),
 * but they do respect what the file's header says:
 *  - Matroska (MKV/WebM): the first audio TrackEntry plays.
 *  - MP4/MOV: the audio track whose `tkhd` is flagged "enabled" plays.
 * So we rewrite only that header region, keeping its size identical so no other offset in the
 * file moves, and stitch it between untouched slices of the original file. The resulting Blob
 * references the original file instead of copying it, so switching is instant even for 4 GB.
 */

export interface AudioTrackInfo {
  id: string;
  label: string;
}

export interface FileAudioTracks {
  tracks: AudioTrackInfo[];
  /** The track the file plays by default. */
  defaultId: string;
  /** A playable copy of the file whose default audio is `id` (cheap: no data is copied). */
  withAudio(id: string): Blob;
}

const readBytes = async (file: Blob, start: number, length: number) =>
  new Uint8Array(await file.slice(start, Math.min(file.size, start + length)).arrayBuffer());

// ---------------------------------------------------------------- language names

const ISO_639_2: Record<string, string> = {
  eng: 'en', hin: 'hi', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', mar: 'mr', guj: 'gu', pan: 'pa',
  urd: 'ur', ori: 'or', asm: 'as', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', jpn: 'ja', kor: 'ko',
  chi: 'zh', zho: 'zh', ita: 'it', por: 'pt', rus: 'ru', ara: 'ar', tur: 'tr', tha: 'th', vie: 'vi', ind: 'id',
  may: 'ms', msa: 'ms', fil: 'fil', pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi',
  gre: 'el', ell: 'el', heb: 'he', per: 'fa', fas: 'fa', ukr: 'uk', cze: 'cs', ces: 'cs', hun: 'hu', rum: 'ro', ron: 'ro',
};

function languageName(code: string | undefined): string | null {
  if (!code || code === 'und' || code === 'mis' || code === 'zxx') return null;
  const tag = ISO_639_2[code.toLowerCase()] ?? code;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    return name && name.toLowerCase() !== tag.toLowerCase() ? name : code;
  } catch {
    return code;
  }
}

export function makeLabel(index: number, name: string | undefined, language: string | undefined, channels?: number): string {
  const lang = languageName(language);
  const base = name?.trim() || lang || `Audio ${index + 1}`;
  const withLang = lang && name && !name.toLowerCase().includes(lang.toLowerCase()) ? `${base} (${lang})` : base;
  return channels && channels > 2 ? `${withLang} · ${channels === 6 ? '5.1' : channels === 8 ? '7.1' : `${channels}ch`}` : withLang;
}

// ---------------------------------------------------------------- Matroska / WebM (EBML)

const EBML_ID = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TRACK_ENTRY = 0xae;
const CRC32 = 0xbf;

interface Vint {
  value: number;
  length: number;
  unknown?: boolean;
}

/** EBML variable-length integer. IDs keep their length marker; sizes don't. */
function vint(bytes: Uint8Array, pos: number, isId: boolean): Vint | null {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > (isId ? 4 : 8) || pos + length > bytes.length) return null;
  let value = isId ? first : first & (0xff >> length);
  let allOnes = value === (0xff >> length);
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !isId && allOnes };
}

interface Element {
  id: number;
  /** Offsets relative to the buffer being parsed. */
  start: number;
  dataStart: number;
  end: number;
}

function children(bytes: Uint8Array, from: number, to: number): Element[] {
  const out: Element[] = [];
  let pos = from;
  while (pos < to) {
    const id = vint(bytes, pos, true);
    const size = id && vint(bytes, pos + id.length, false);
    if (!id || !size || size.unknown) break;
    const dataStart = pos + id.length + size.length;
    const end = dataStart + size.value;
    if (end > to) break;
    out.push({ id: id.value, start: pos, dataStart, end });
    pos = end;
  }
  return out;
}

const uint = (b: Uint8Array, e: Element) => {
  let v = 0;
  for (let i = e.dataStart; i < e.end; i++) v = v * 256 + b[i];
  return v;
};
const text = (b: Uint8Array, e: Element) => new TextDecoder().decode(b.subarray(e.dataStart, e.end)).replace(/\0+$/, '');

async function readMatroska(file: Blob): Promise<FileAudioTracks | null> {
  const head = await readBytes(file, 0, 64);
  const ebml = vint(head, 0, true);
  if (ebml?.value !== EBML_ID) return null;
  const ebmlSize = vint(head, ebml.length, false)!;
  let pos = ebml.length + ebmlSize.length + ebmlSize.value;

  const segHead = await readBytes(file, pos, 16);
  const seg = vint(segHead, 0, true);
  if (seg?.value !== SEGMENT) return null;
  pos += seg.length + vint(segHead, seg.length, false)!.length;

  // Walk the Segment's top-level children (reading only their headers) until Tracks.
  for (let guard = 0; guard < 300 && pos < file.size; guard++) {
    const h = await readBytes(file, pos, 16);
    const id = vint(h, 0, true);
    const size = id && vint(h, id.length, false);
    if (!id || !size || size.unknown || id.value === CLUSTER) return null;
    const dataStart = pos + id.length + size.length;
    if (id.value !== TRACKS) {
      pos = dataStart + size.value;
      continue;
    }
    if (size.value > 4 * 1024 * 1024) return null;
    const payload = await readBytes(file, dataStart, size.value);
    return parseMatroskaTracks(file, payload, dataStart);
  }
  return null;
}

function parseMatroskaTracks(file: Blob, payload: Uint8Array, payloadOffset: number): FileAudioTracks | null {
  const items = children(payload, 0, payload.length);
  type Entry = { el: Element; type: number; number: number; name?: string; lang?: string; channels?: number; flagDefault?: number; isDefault: boolean };
  const entries: Entry[] = [];
  for (const el of items) {
    if (el.id !== TRACK_ENTRY) continue;
    const entry: Entry = { el, type: 0, number: 0, isDefault: true };
    for (const c of children(payload, el.dataStart, el.end)) {
      if (c.id === 0x83) entry.type = uint(payload, c);
      else if (c.id === 0xd7) entry.number = uint(payload, c);
      else if (c.id === 0x536e) entry.name = text(payload, c);
      else if (c.id === 0x22b59c && !entry.lang) entry.lang = text(payload, c);
      else if (c.id === 0x22b59d) entry.lang = text(payload, c).split('-')[0];
      else if (c.id === 0x88) {
        entry.isDefault = uint(payload, c) === 1;
        if (c.end - c.dataStart === 1) entry.flagDefault = c.dataStart;
      } else if (c.id === 0xe1) {
        for (const a of children(payload, c.dataStart, c.end)) if (a.id === 0x9f) entry.channels = uint(payload, a);
      }
    }
    entries.push(entry);
  }
  const audio = entries.filter((e) => e.type === 2);
  if (audio.length < 2) return null;

  const tracks = audio.map((e, i) => ({ id: String(e.number), label: makeLabel(i, e.name, e.lang, e.channels) }));
  return {
    tracks,
    // Chrome plays the first audio entry, so that's what the file plays today.
    defaultId: String(audio[0].number),
    withAudio(id) {
      const chosen = audio.find((e) => String(e.number) === id) ?? audio[0];
      // Same elements, new order: CRC first (it must be), other tracks, chosen audio, other audio, the rest.
      const order = [
        ...items.filter((el) => el.id === CRC32),
        ...entries.filter((e) => e.type !== 2).map((e) => e.el),
        chosen.el,
        ...audio.filter((e) => e !== chosen).map((e) => e.el),
        ...items.filter((el) => el.id !== CRC32 && el.id !== TRACK_ENTRY),
      ];
      const out = new Uint8Array(payload.length);
      let at = 0;
      for (const el of order) {
        const bytes = payload.slice(el.start, el.end);
        // Also move the "default" flag when the file stores it as a single byte.
        const entry = audio.find((e) => e.el === el);
        if (entry?.flagDefault !== undefined) bytes[entry.flagDefault - el.start] = entry === chosen ? 1 : 0;
        out.set(bytes, at);
        at += bytes.length;
      }
      // Bytes between/after children (shouldn't exist, but keep the size exact if they do).
      if (at < payload.length) out.set(payload.slice(at), at);
      return new Blob([file.slice(0, payloadOffset), out, file.slice(payloadOffset + payload.length)], { type: file.type });
    },
  };
}

// ---------------------------------------------------------------- MP4 / MOV

const fourcc = (b: Uint8Array, p: number) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
const u32 = (b: Uint8Array, p: number) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;

interface Box {
  type: string;
  start: number;
  dataStart: number;
  end: number;
}

function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let pos = from;
  while (pos + 8 <= to) {
    let size = u32(b, pos);
    const type = fourcc(b, pos + 4);
    let header = 8;
    if (size === 1) {
      size = u32(b, pos + 8) * 2 ** 32 + u32(b, pos + 12);
      header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header || pos + size > to) break;
    out.push({ type, start: pos, dataStart: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

async function readMp4(file: Blob): Promise<FileAudioTracks | null> {
  // Find moov among top-level boxes (it may come after a huge mdat), reading only headers.
  let pos = 0;
  for (let guard = 0; guard < 100 && pos < file.size; guard++) {
    const h = await readBytes(file, pos, 16);
    if (h.length < 8) return null;
    let size = u32(h, 0);
    const type = fourcc(h, 4);
    if (guard === 0 && type !== 'ftyp' && type !== 'moov' && type !== 'free' && type !== 'wide' && type !== 'mdat') return null;
    if (size === 1) size = u32(h, 8) * 2 ** 32 + u32(h, 12);
    else if (size === 0) size = file.size - pos;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > 64 * 1024 * 1024) return null;
      const moov = await readBytes(file, pos, size);
      return parseMoov(file, moov, pos);
    }
    pos += size;
  }
  return null;
}

function parseMoov(file: Blob, moov: Uint8Array, moovOffset: number): FileAudioTracks | null {
  const [root] = boxes(moov, 0, moov.length);
  if (!root || root.type !== 'moov') return null;
  type Trak = { id: number; flagsByte: number; enabled: boolean; name?: string; lang?: string; channels?: number };
  const audio: Trak[] = [];

  for (const trak of boxes(moov, root.dataStart, root.end).filter((b) => b.type === 'trak')) {
    const inner = boxes(moov, trak.dataStart, trak.end);
    const tkhd = inner.find((b) => b.type === 'tkhd');
    const mdia = inner.find((b) => b.type === 'mdia');
    if (!tkhd || !mdia) continue;
    const mdiaKids = boxes(moov, mdia.dataStart, mdia.end);
    const hdlr = mdiaKids.find((b) => b.type === 'hdlr');
    if (!hdlr || fourcc(moov, hdlr.dataStart + 8) !== 'soun') continue;

    const version = moov[tkhd.dataStart];
    const id = u32(moov, tkhd.dataStart + (version === 1 ? 20 : 12));
    const flagsByte = tkhd.dataStart + 3; // low byte of the 24-bit flags; bit 0 = track enabled
    const track: Trak = { id, flagsByte, enabled: (moov[flagsByte] & 1) === 1 };

    const mdhd = mdiaKids.find((b) => b.type === 'mdhd');
    if (mdhd) {
      const p = mdhd.dataStart + (moov[mdhd.dataStart] === 1 ? 32 : 20);
      const packed = (moov[p] << 8) | moov[p + 1];
      const lang = String.fromCharCode(((packed >> 10) & 31) + 0x60, ((packed >> 5) & 31) + 0x60, (packed & 31) + 0x60);
      if (/^[a-z]{3}$/.test(lang)) track.lang = lang;
    }
    // hdlr name (ISO: C string; QuickTime: length-prefixed); skip generic muxer names.
    const nameBytes = moov.subarray(hdlr.dataStart + 24, hdlr.end);
    const raw = new TextDecoder().decode(nameBytes[0] === nameBytes.length - 1 ? nameBytes.subarray(1) : nameBytes).replace(/\0.*$/s, '').trim();
    if (raw && !/^(sound ?handler|soundhandler|core media audio|audio ?handler)$/i.test(raw)) track.name = raw;
    // Channel count from the first sample entry: minf/stbl/stsd/<codec>.
    const minf = mdiaKids.find((b) => b.type === 'minf');
    const stbl = minf && boxes(moov, minf.dataStart, minf.end).find((b) => b.type === 'stbl');
    const stsd = stbl && boxes(moov, stbl.dataStart, stbl.end).find((b) => b.type === 'stsd');
    if (stsd) {
      const entry = boxes(moov, stsd.dataStart + 8, stsd.end)[0];
      if (entry) track.channels = (moov[entry.dataStart + 16] << 8) | moov[entry.dataStart + 17];
    }
    audio.push(track);
  }
  if (audio.length < 2) return null;

  return {
    tracks: audio.map((t, i) => ({ id: String(t.id), label: makeLabel(i, t.name, t.lang, t.channels) })),
    defaultId: String((audio.find((t) => t.enabled) ?? audio[0]).id),
    withAudio(id) {
      // Flip only the "enabled" bits; everything else (and every size/offset) stays the same.
      const out = moov.slice();
      for (const t of audio) out[t.flagsByte] = String(t.id) === id ? out[t.flagsByte] | 1 : out[t.flagsByte] & ~1;
      return new Blob([file.slice(0, moovOffset), out, file.slice(moovOffset + moov.length)], { type: file.type });
    },
  };
}

/** Lists a movie file's audio tracks (when it has more than one) and how to pick one. */
export async function readFileAudioTracks(file: Blob): Promise<FileAudioTracks | null> {
  try {
    return (await readMatroska(file)) ?? (await readMp4(file));
  } catch {
    return null;
  }
}
