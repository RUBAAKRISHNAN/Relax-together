import { Sofa } from 'lucide-react';

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-pink-500 shadow-lg shadow-fuchsia-500/30">
        <Sofa className="h-5 w-5 text-white" aria-hidden />
      </div>
      <span className={`text-lg font-extrabold tracking-tight ${compact ? 'hidden sm:inline' : ''}`}>
        Relax <span className="text-gradient">Together</span>
      </span>
    </div>
  );
}
