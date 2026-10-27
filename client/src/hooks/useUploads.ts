import { useCallback, useRef, useState } from 'react';
import { UPLOAD_MAX_BYTES } from '@shared/constants';
import type { UploadResponse } from '@shared/types';
import { useToast } from '../components/Toasts';
import { SERVER_URL } from '../lib/env';

export interface UploadJob {
  id: number;
  name: string;
  progress: number;
  status: 'waiting' | 'uploading' | 'done' | 'error';
  error?: string;
}

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|webm|aif|aiff|wma|3gp)$/i;
export const AUDIO_ACCEPT = 'audio/*,.mp3,.m4a,.aac,.flac,.wav,.ogg,.opus,.webm,.aiff';

export const isAudioFile = (f: File) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name);

function send(url: string, file: File, token: string, onProgress: (p: number) => void): Promise<UploadResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Upload-Token', token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: (UploadResponse & { error?: string }) | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* handled below */
      }
      if (xhr.status === 201 && body) resolve(body);
      else reject(new Error(body?.error ?? `Upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("Couldn't reach the server."));
    xhr.send(file);
  });
}

/** Uploads songs from the user's device into a music room, one at a time, with progress. */
export function useUploads(roomId: string, getToken: () => Promise<{ token: string } | { error: string }>) {
  const [jobs, setJobs] = useState<UploadJob[]>([]);
  const toast = useToast();
  const nextId = useRef(1);
  const chain = useRef(Promise.resolve());

  const patch = (id: number, p: Partial<UploadJob>) => setJobs((all) => all.map((j) => (j.id === id ? { ...j, ...p } : j)));

  const upload = useCallback(
    (files: File[]) => {
      const accepted: { job: UploadJob; file: File }[] = [];
      for (const file of files) {
        if (!isAudioFile(file)) {
          toast(`“${file.name}” isn't an audio file.`, 'error');
          continue;
        }
        if (file.size > UPLOAD_MAX_BYTES) {
          toast(`“${file.name}” is over 50 MB.`, 'error');
          continue;
        }
        accepted.push({ job: { id: nextId.current++, name: file.name, progress: 0, status: 'waiting' }, file });
      }
      if (!accepted.length) return;
      setJobs((all) => [...all, ...accepted.map((a) => a.job)]);

      for (const { job, file } of accepted) {
        chain.current = chain.current.then(async () => {
          patch(job.id, { status: 'uploading' });
          const auth = await getToken();
          if ('error' in auth) {
            patch(job.id, { status: 'error', error: auth.error });
            return;
          }
          try {
            const res = await send(`${SERVER_URL}/api/rooms/${roomId}/uploads`, file, auth.token, (p) => patch(job.id, { progress: p }));
            patch(job.id, { status: 'done', progress: 1 });
            toast(res.placement === 'playing' ? `Now playing “${res.track.title}” 🎶` : `Added “${res.track.title}” to the queue`);
            setTimeout(() => setJobs((all) => all.filter((j) => j.id !== job.id)), 2500);
          } catch (err) {
            patch(job.id, { status: 'error', error: (err as Error).message });
            setTimeout(() => setJobs((all) => all.filter((j) => j.id !== job.id)), 8000);
          }
        });
      }
    },
    // getToken/toast are stable for the lifetime of the room.
    [roomId],
  );

  return { jobs, upload };
}
