import type { MoodId } from '@shared/constants';

export interface Mood {
  id: MoodId;
  name: string;
  emoji: string;
  vibe: string;
  /** Sky/backdrop behind the animated canvas. */
  background: string;
  /** Accent for chips and highlights. */
  accent: string;
}

export const MOODS: Mood[] = [
  {
    id: 'calm',
    name: 'Cherry Blossom',
    emoji: '🌸',
    vibe: 'Calm',
    background: 'linear-gradient(180deg, #fde4ef 0%, #f6c9de 32%, #d7bde8 64%, #a99bd3 100%)',
    accent: '#f472b6',
  },
  {
    id: 'rain',
    name: 'Rainy Window',
    emoji: '🌧️',
    vibe: 'Cozy',
    background: 'linear-gradient(180deg, #0c1626 0%, #13243b 45%, #1d3352 75%, #2a2440 100%)',
    accent: '#60a5fa',
  },
  {
    id: 'night',
    name: 'Starry Night',
    emoji: '🌙',
    vibe: 'Dreamy',
    background: 'linear-gradient(180deg, #03051a 0%, #0b1033 40%, #1d1648 75%, #33205a 100%)',
    accent: '#a78bfa',
  },
  {
    id: 'sunset',
    name: 'Golden Hour',
    emoji: '🌅',
    vibe: 'Warm',
    background: 'linear-gradient(180deg, #2d1b4e 0%, #6d2e6a 28%, #d9546e 52%, #ff9e5e 66%, #3a2a5c 66.1%, #1c1838 100%)',
    accent: '#fb923c',
  },
  {
    id: 'forest',
    name: 'Firefly Forest',
    emoji: '🌲',
    vibe: 'Focus',
    background: 'linear-gradient(180deg, #071a14 0%, #0b2a1f 45%, #0f3527 75%, #05140e 100%)',
    accent: '#a3e635',
  },
  {
    id: 'ocean',
    name: 'Ocean Breeze',
    emoji: '🌊',
    vibe: 'Fresh',
    background: 'linear-gradient(180deg, #bdeef5 0%, #7fd4e4 30%, #2f9fbf 58%, #0c5d80 80%, #063650 100%)',
    accent: '#22d3ee',
  },
  {
    id: 'party',
    name: 'Neon Party',
    emoji: '🎉',
    vibe: 'Energetic',
    background: 'radial-gradient(ellipse at 50% 120%, #3b0a5c 0%, #14002b 55%, #07000f 100%)',
    accent: '#e879f9',
  },
];

export const moodById = (id: MoodId): Mood => MOODS.find((m) => m.id === id) ?? MOODS[0];
