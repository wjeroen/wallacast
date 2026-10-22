import { useEffect, useRef } from 'react';

// YouTube's embedded player for a video item, driven through the IFrame Player API
// (https://developers.google.com/youtube/iframe_api_reference). AudioPlayer owns the
// playback state and calls the player's methods, the fullscreen view decides where this
// box sits. YouTube's rules for embeds shape it: the player stays at least 200x200 px,
// nothing is drawn over it, and it only plays while it is on screen (minimizing the
// player pauses it, see AudioPlayer).

// The part of YouTube's player object the app calls
export interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  cueVideoById(options: { videoId: string; startSeconds?: number }): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getAvailablePlaybackRates(): number[];
  setPlaybackRate(rate: number): void;
  destroy(): void;
}

// YT.PlayerState values
export const VIDEO_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const;

interface YouTubeEvent<T = unknown> {
  target: YouTubePlayer;
  data: T;
}

interface YouTubeApi {
  Player: new (target: HTMLElement, options: Record<string, unknown>) => YouTubePlayer;
}

declare global {
  interface Window {
    YT?: YouTubeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

// The API script loads once per page, and every player waits for the same promise.
let apiPromise: Promise<YouTubeApi> | null = null;
function loadYouTubeApi(): Promise<YouTubeApi> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      if (window.YT) resolve(window.YT);
      else reject(new Error('The YouTube player script loaded without its API'));
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    script.onerror = () => {
      apiPromise = null;
      script.remove();
      reject(new Error('The YouTube player script did not load'));
    };
    document.head.appendChild(script);
  });
  return apiPromise;
}

interface YouTubeVideoProps {
  videoId: string;
  // Where the video starts. Read once, when the player is built.
  startSeconds: number;
  onReady: (player: YouTubePlayer) => void;
  onStateChange: (state: number) => void;
  onRateChange: (rate: number) => void;
  // A YouTube error code (100 not found, 101 and 150 embedding not allowed, ...), or -1
  // when the player script itself did not load
  onError: (code: number) => void;
}

export function YouTubeVideo({ videoId, startSeconds, onReady, onStateChange, onRateChange, onError }: YouTubeVideoProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // The latest callbacks, so the player is built once per video and not on every render
  const callbacks = useRef({ onReady, onStateChange, onRateChange, onError });
  useEffect(() => {
    callbacks.current = { onReady, onStateChange, onRateChange, onError };
  });
  const startRef = useRef(startSeconds);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // YouTube replaces its target element with the iframe, so the target is a plain div
    // that React never renders or removes itself.
    const target = document.createElement('div');
    host.appendChild(target);
    let player: YouTubePlayer | null = null;
    let cancelled = false;
    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        player = new YT.Player(target, {
          // Privacy-enhanced mode: YouTube sets no cookies until the video plays
          host: 'https://www.youtube-nocookie.com',
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            playsinline: 1,
            rel: 0,
            start: Math.floor(startRef.current) || undefined,
            origin: window.location.origin,
          },
          events: {
            onReady: (e: YouTubeEvent) => callbacks.current.onReady(e.target),
            onStateChange: (e: YouTubeEvent<number>) => callbacks.current.onStateChange(e.data),
            onPlaybackRateChange: (e: YouTubeEvent<number>) => callbacks.current.onRateChange(e.data),
            onError: (e: YouTubeEvent<number>) => callbacks.current.onError(e.data),
          },
        });
      })
      .catch((err) => {
        console.error('[YouTubeVideo]', err);
        if (!cancelled) callbacks.current.onError(-1);
      });
    return () => {
      cancelled = true;
      try { player?.destroy(); } catch { /* already gone */ }
      host.replaceChildren();
    };
  }, [videoId]);

  return <div className="fullscreen-video" ref={hostRef} />;
}
