import { initials, readableTextOn } from '../lib/format';

const SIZES = {
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
};

interface AvatarProps {
  name: string;
  color: string;
  size?: keyof typeof SIZES;
  online?: boolean;
}

export function Avatar({ name, color, size = 'md', online }: AvatarProps) {
  return (
    <div className="relative shrink-0">
      <div
        className={`grid place-items-center rounded-full font-semibold shadow-sm ${SIZES[size]}`}
        style={{ background: color, color: readableTextOn(color) }}
        aria-hidden
      >
        {initials(name)}
      </div>
      {online !== undefined && (
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-card ${
            online ? 'bg-emerald-400' : 'bg-zinc-400'
          }`}
          title={online ? 'Online' : 'Reconnecting'}
        />
      )}
    </div>
  );
}
