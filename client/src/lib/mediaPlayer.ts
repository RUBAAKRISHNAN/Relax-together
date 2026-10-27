/**
 * The slice of the YouTube IFrame player API the sync engine relies on. A real `YT.Player`
 * satisfies it as-is; `HybridPlayer` implements it for music rooms (YouTube + uploaded audio).
 * States use the YouTube numbering (see `PlayerState`).
 */
export interface MediaPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  getVolume(): number;
  setVolume(volume: number): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  /** Includes `isLive` at runtime, though the IFrame API typings leave it out. */
  getVideoData?(): object;
  /** Wall-clock time (s) of the frame on screen; live streams only. */
  getMediaReferenceTime?(): number;
  /** True when seeking is instant (a file on this device), so drift is fixed by seeking, not nudging. */
  hasInstantSeek?(): boolean;
}
