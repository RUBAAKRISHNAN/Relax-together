import { FILE_SOURCE_PREFIX, isFileSource } from '@shared/constants';
import type { MediaPlayer } from './mediaPlayer';
import { AUDIO_ERROR, PlayerState } from './youtubeApi';

interface HybridEvents {
  onStateChange: (state: number) => void;
  onError: (code: number) => void;
  /** Which backend is active, so the UI can show the YouTube player or the cover art. */
  onSourceChange: (source: 'youtube' | 'audio') => void;
}

/**
 * One player for music rooms: songs from YouTube play in the (visible) YouTube player, songs
 * people uploaded play in an <audio> element. To the sync engine it looks exactly like a
 * YouTube player: same methods and the same state numbers. That keeps the sync logic shared.
 * Events from whichever backend isn't active are ignored.
 */
export class HybridPlayer implements MediaPlayer {
  private active: 'youtube' | 'audio' = 'youtube';
  private volume = 100;
  private muted = false;
  private waiting = false;
  private analyser: AnalyserNode | null = null;
  private context: AudioContext | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;
  private level = 0;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private yt: YT.Player,
    private audio: HTMLAudioElement,
    private urlFor: (fileId: string) => string,
    private events: HybridEvents,
  ) {
    audio.preload = 'auto';
    // Needed for the analyser: our server sends CORS headers for /media.
    audio.crossOrigin = 'anonymous';
    const on = (type: string, fn: () => void) => {
      audio.addEventListener(type, fn);
      this.cleanup.push(() => audio.removeEventListener(type, fn));
    };
    const emit = (state: number) => this.active === 'audio' && this.events.onStateChange(state);
    on('playing', () => {
      this.waiting = false;
      this.enableAnalyser();
      emit(PlayerState.PLAYING);
    });
    on('pause', () => !audio.ended && emit(PlayerState.PAUSED));
    on('waiting', () => {
      this.waiting = true;
      emit(PlayerState.BUFFERING);
    });
    on('canplay', () => {
      if (!this.waiting) return;
      this.waiting = false;
      if (!audio.paused) emit(PlayerState.PLAYING);
    });
    on('ended', () => emit(PlayerState.ENDED));
    on('error', () => this.active === 'audio' && audio.getAttribute('src') && this.events.onError(AUDIO_ERROR));
  }

  /** Forwarded from the YouTube player's own onStateChange. */
  handleYouTubeState(state: number) {
    if (this.active === 'youtube') this.events.onStateChange(state);
  }

  handleYouTubeError(code: number) {
    if (this.active === 'youtube') this.events.onError(code);
  }

  private switchTo(next: 'youtube' | 'audio') {
    if (this.active === next) return;
    this.active = next;
    if (next === 'audio') {
      this.yt.pauseVideo();
    } else {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.events.onSourceChange(next);
  }

  private load(options: { videoId: string; startSeconds?: number }, autoplay: boolean) {
    if (isFileSource(options.videoId)) {
      this.switchTo('audio');
      this.audio.src = this.urlFor(options.videoId.slice(FILE_SOURCE_PREFIX.length));
      // Setting currentTime before metadata loads is allowed; it becomes the start position.
      this.audio.currentTime = options.startSeconds ?? 0;
      this.audio.playbackRate = 1;
      this.events.onStateChange(PlayerState.UNSTARTED);
      if (autoplay) void this.audio.play().catch(() => {});
    } else {
      this.switchTo('youtube');
      if (autoplay) this.yt.loadVideoById(options);
      else this.yt.cueVideoById(options);
    }
  }

  loadVideoById(options: { videoId: string; startSeconds?: number }) {
    this.load(options, true);
  }

  cueVideoById(options: { videoId: string; startSeconds?: number }) {
    this.load(options, false);
  }

  playVideo() {
    if (this.active === 'audio') void this.audio.play().catch(() => {});
    else this.yt.playVideo();
  }

  pauseVideo() {
    if (this.active === 'audio') this.audio.pause();
    else this.yt.pauseVideo();
  }

  stopVideo() {
    this.audio.pause();
    this.yt.stopVideo();
  }

  seekTo(seconds: number, allowSeekAhead: boolean) {
    if (this.active === 'youtube') return this.yt.seekTo(seconds, allowSeekAhead);
    const d = this.audio.duration;
    this.audio.currentTime = Number.isFinite(d) && d > 0 ? Math.min(seconds, d) : seconds;
  }

  getCurrentTime() {
    return this.active === 'audio' ? this.audio.currentTime : this.yt.getCurrentTime();
  }

  getDuration() {
    if (this.active === 'youtube') return this.yt.getDuration();
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  getPlayerState() {
    if (this.active === 'youtube') return this.yt.getPlayerState();
    const a = this.audio;
    if (!a.getAttribute('src')) return PlayerState.UNSTARTED;
    if (a.ended) return PlayerState.ENDED;
    if (a.paused) return PlayerState.PAUSED;
    return this.waiting || a.readyState < HTMLMediaElement.HAVE_FUTURE_DATA ? PlayerState.BUFFERING : PlayerState.PLAYING;
  }

  getPlaybackRate() {
    return this.active === 'audio' ? this.audio.playbackRate : this.yt.getPlaybackRate();
  }

  setPlaybackRate(rate: number) {
    if (this.active === 'audio') this.audio.playbackRate = rate;
    else this.yt.setPlaybackRate(rate);
  }

  /** <audio> takes any speed; small steps keep catch-up nudges inaudible (pitch is preserved). */
  getAvailablePlaybackRates() {
    return this.active === 'audio' ? [0.97, 1, 1.03] : this.yt.getAvailablePlaybackRates();
  }

  getVolume() {
    return this.volume;
  }

  setVolume(volume: number) {
    this.volume = volume;
    this.yt.setVolume(volume);
    this.audio.volume = volume / 100;
  }

  mute() {
    this.muted = true;
    this.yt.mute();
    this.audio.muted = true;
  }

  unMute() {
    this.muted = false;
    this.yt.unMute();
    this.audio.muted = false;
  }

  isMuted() {
    return this.muted;
  }

  getVideoData() {
    return this.active === 'youtube' ? (this.yt as unknown as { getVideoData(): object }).getVideoData() : { isLive: false };
  }

  getMediaReferenceTime() {
    return this.active === 'youtube' ? ((this.yt as unknown as { getMediaReferenceTime?: () => number }).getMediaReferenceTime?.() ?? 0) : 0;
  }

  get source() {
    return this.active;
  }

  /**
   * Loudness 0..1 of the uploaded song that's playing, for music-reactive scenes. Returns null
   * for YouTube songs (a cross-origin iframe can't be analysed) or before audio is flowing.
   */
  getLevel(): number | null {
    if (this.active !== 'audio' || !this.analyser || !this.samples || this.audio.paused) return null;
    this.analyser.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += ((v - 128) / 128) ** 2;
    const rms = Math.sqrt(sum / this.samples.length);
    // Fast attack, slow release reads as a "beat" rather than flicker.
    const target = Math.min(1, rms * 3.2);
    this.level = target > this.level ? target : this.level * 0.9 + target * 0.1;
    return this.level;
  }

  /**
   * Routes the <audio> element through an analyser. Only done once the AudioContext is actually
   * running (the page has had a user gesture); a suspended context would silence the element.
   */
  private enableAnalyser() {
    if (this.analyser || typeof AudioContext === 'undefined') return;
    try {
      this.context ??= new AudioContext();
      const ctx = this.context;
      const connect = () => {
        if (this.analyser || ctx.state !== 'running') return;
        const source = ctx.createMediaElementSource(this.audio);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        analyser.connect(ctx.destination);
        this.analyser = analyser;
        this.samples = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      };
      if (ctx.state === 'running') connect();
      else void ctx.resume().then(connect).catch(() => {});
    } catch {
      /* analyser is a nice-to-have */
    }
  }

  destroy() {
    this.cleanup.forEach((fn) => fn());
    this.audio.pause();
    this.audio.removeAttribute('src');
    void this.context?.close().catch(() => {});
  }
}
