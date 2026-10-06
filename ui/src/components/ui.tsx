/** Small presentational primitives. Plain-language copy only (architecture §6.5). */

import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { copyToClipboard } from '../lib/download';

export function Button({
  variant = 'primary',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  const styles = {
    primary: 'bg-accent text-white hover:opacity-90 disabled:opacity-40',
    secondary: 'bg-accent-soft text-accent hover:opacity-80 disabled:opacity-40',
    danger: 'bg-bad-soft text-bad hover:opacity-80 disabled:opacity-40',
  }[variant];
  return (
    <button
      type="button"
      className={`rounded-lg px-4 py-2.5 text-sm font-semibold transition disabled:cursor-not-allowed ${styles} ${className}`}
      {...rest}
    />
  );
}

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-ink/10 bg-white p-4 sm:p-6 ${className}`}>
      {title !== undefined && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      <input
        className="w-full rounded-lg border border-ink/20 px-3 py-2 text-sm focus:border-accent"
        {...rest}
      />
      {hint && <span className="mt-1 block text-xs text-ink/60">{hint}</span>}
    </label>
  );
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  const styles = {
    info: 'bg-accent-soft text-ink',
    ok: 'bg-ok-soft text-ink',
    warn: 'bg-warn-soft text-ink',
    bad: 'bg-bad-soft text-ink',
  }[tone];
  return <div className={`rounded-lg p-3 text-sm leading-relaxed ${styles}`}>{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-ink/70" role="status">
      <span className="inline-block size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      {label}
    </span>
  );
}

export const CONFIRMING_TEXT =
  'Waiting for the network to confirm — about 15–20 minutes on Sepolia, 1–2 minutes on Gnosis. You can close this page and come back.';

/**
 * A just-sent step (or a fresh deployment) is not confirmed by the network
 * yet. A transient wait, never a failure — whoever renders this keeps
 * polling and the page moves on by itself once the network catches up.
 * `lead` says what was sent ("Your committee was created.").
 */
export function ConfirmingNote({ lead }: { lead?: string }) {
  return (
    <Note tone="info">
      <Spinner label={lead ? `${lead} ${CONFIRMING_TEXT}` : CONFIRMING_TEXT} />
    </Note>
  );
}

export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  return (
    <div>
      {label && <div className="mb-1 text-xs text-ink/70">{label}</div>}
      <div className="h-2 w-full overflow-hidden rounded-full bg-ink/10">
        <div
          className={`h-full rounded-full bg-accent transition-all ${value === null ? 'w-1/3 animate-pulse' : ''}`}
          style={value === null ? undefined : { width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      onClick={() => {
        void copyToClipboard(text).then((ok) => {
          setCopied(ok);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** "Details for auditors" — collapsed technical values, out of the main flow. */
export function Disclosure({ summary = 'Details for auditors', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="mt-3 rounded-lg border border-ink/10 p-3 text-xs text-ink/70">
      <summary className="cursor-pointer select-none font-medium">{summary}</summary>
      <div className="mt-2 break-all font-mono leading-relaxed">{children}</div>
    </details>
  );
}
