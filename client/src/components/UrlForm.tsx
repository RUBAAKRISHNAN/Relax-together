import { AnimatePresence, motion } from 'framer-motion';
import { Link2, Loader2, type LucideIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { parseYouTubeUrl } from '@shared/youtube';

interface UrlFormProps {
  label: string;
  placeholder: string;
  submitLabel: string;
  submitIcon: LucideIcon;
  /** Resolves with an error message, or null on success. */
  onSubmit: (url: string) => Promise<string | null>;
}

export function UrlForm({ label, placeholder, submitLabel, submitIcon: Icon, onSubmit }: UrlFormProps) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const inputId = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Validate locally first for instant feedback; the server validates again.
    const parsed = parseYouTubeUrl(value);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    const err = await onSubmit(value.trim());
    setBusy(false);
    setError(err);
    if (!err) setValue('');
  };

  return (
    <form onSubmit={submit} noValidate>
      <label htmlFor={inputId} className="sr-only">
        {label}
      </label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Link2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder={placeholder}
            className="input py-2.5 pl-10 text-sm"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
          />
        </div>
        <button type="submit" className="btn-primary shrink-0 px-4 text-sm" disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Icon className="h-4 w-4" aria-hidden />}
          <span className="hidden min-[400px]:inline">{submitLabel}</span>
        </button>
      </div>
      <AnimatePresence>
        {error && (
          <motion.p
            id={errorId}
            role="alert"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden pt-2 text-sm text-red-600 dark:text-red-400"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </form>
  );
}
