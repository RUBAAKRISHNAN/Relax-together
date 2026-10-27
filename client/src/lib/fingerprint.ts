const CHUNK = 256 * 1024;

/**
 * A quick identity for a (possibly multi-GB) movie file: its size plus a hash of three 256 KB
 * samples (start, middle, end). Reading 768 KB takes milliseconds, and two different encodes of a
 * movie practically never collide. Pure JS (FNV-1a), so it also works on plain-http LAN addresses
 * where crypto.subtle isn't available.
 */
export async function fingerprintFile(file: File): Promise<string> {
  const offsets = [0, Math.max(0, Math.floor(file.size / 2) - CHUNK / 2), Math.max(0, file.size - CHUNK)];
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ (file.size >>> 0);
  for (const offset of offsets) {
    const bytes = new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer());
    for (let i = 0; i < bytes.length; i++) {
      h1 = Math.imul(h1 ^ bytes[i], 16777619);
      h2 = Math.imul(h2 ^ bytes[i], 2246822519);
    }
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${file.size.toString(36)}:${hex(h1)}${hex(h2)}`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Reads a movie's duration (and whether the browser can decode it) without playing it. */
export function probeVideo(src: string): Promise<{ duration: number; hasVideo: boolean }> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error("Couldn't read this video. Is it a movie file?"))), 15_000);
    video.onloadedmetadata = () => {
      // Read before done() clears the element (which resets these to 0).
      const result = { duration: Number.isFinite(video.duration) ? video.duration : 0, hasVideo: video.videoWidth > 0 };
      done(() => resolve(result));
    };
    video.onerror = () =>
      done(() => reject(new Error("Your browser can't play this format. MP4 (H.264 + AAC) works everywhere; convert with HandBrake.")));
    video.src = src;
  });
}
