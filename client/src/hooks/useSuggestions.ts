import { useCallback, useEffect, useState } from 'react';
import { isFileSource, isMovieSource } from '@shared/constants';
import type { SuggestedVideo, SuggestionsResponse } from '@shared/types';
import { SERVER_URL } from '../lib/env';

export interface SuggestionsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  items: SuggestedVideo[];
  error: string | null;
  retry: () => void;
}

/** YouTube's "up next" recommendations for the video that's playing (fetched via our server). */
export function useSuggestions(videoId: string | null): SuggestionsState {
  const [status, setStatus] = useState<SuggestionsState['status']>('idle');
  const [items, setItems] = useState<SuggestedVideo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setItems([]);
    setError(null);
    // Uploaded songs have no YouTube page to take suggestions from.
    if (!videoId || isFileSource(videoId) || isMovieSource(videoId)) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    const controller = new AbortController();
    fetch(`${SERVER_URL}/api/videos/${videoId}/suggestions`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as SuggestionsResponse & { error?: string };
        if (!res.ok) throw new Error(body.error ?? 'Could not load suggestions.');
        setItems(body.suggestions);
        setStatus('ready');
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setError(err instanceof TypeError ? "Can't reach the server for suggestions." : err.message);
        setStatus('error');
      });
    return () => controller.abort();
  }, [videoId, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { status, items, error, retry };
}
