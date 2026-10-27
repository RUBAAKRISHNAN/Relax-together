type YTWindow = Window & { YT?: typeof YT; onYouTubeIframeAPIReady?: () => void };

let pending: Promise<typeof YT> | null = null;

/** Loads the YouTube IFrame Player API script once and resolves with the global `YT`. */
export function loadYouTubeApi(): Promise<typeof YT> {
  const w = window as YTWindow;
  if (w.YT?.Player) return Promise.resolve(w.YT);

  pending ??= new Promise<typeof YT>((resolve, reject) => {
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(w.YT!);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      pending = null;
      script.remove();
      reject(new Error('Could not load the YouTube player. Check your connection or ad blocker.'));
    };
    document.head.appendChild(script);
  });
  return pending;
}

/** YT.PlayerState values (the ambient enum isn't usable at runtime with isolatedModules). */
export const PlayerState = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

/** Error code HybridPlayer reports for uploaded audio that fails to decode. */
export const AUDIO_ERROR = 1001;
/** Error code VideoElementPlayer reports for a movie the browser can't decode. */
export const VIDEO_FILE_ERROR = 1002;

export function describePlayerError(code: number): string {
  switch (code) {
    case 2:
      return 'This video link is invalid.';
    case 5:
      return "This video can't be played in the browser player.";
    case 100:
      return 'This video was removed or made private.';
    case 101:
    case 150:
      return "The video's owner doesn't allow it to be played on other sites.";
    case VIDEO_FILE_ERROR:
      return "This movie couldn't be played in your browser. MP4 (H.264 + AAC) works everywhere; convert other formats with HandBrake.";
    case AUDIO_ERROR:
      return "This audio file couldn't be played. Try a different format (MP3 or M4A work everywhere).";
    default:
      return 'The video failed to play.';
  }
}
