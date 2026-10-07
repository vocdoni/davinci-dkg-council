/** Small presentational primitives. Plain-language copy only (architecture §6.5). */

import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { copyToClipboard } from '../lib/download';
import { buttonClass, type ButtonSize, type ButtonVariant } from './buttonClass';
import {
  AlertCircleIcon,
  AlertIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  CopyIcon,
  InfoIcon,
} from './icons';

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type="button" className={`${buttonClass(variant, size)} ${className}`} {...rest} />;
}

/** A row of actions: stacked full-width on phones, inline from `sm` up. */
export function Actions({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center [&>.btn]:w-full sm:[&>.btn]:w-auto ${className}`}>
      {children}
    </div>
  );
}

export function Card({
  title,
  description,
  icon,
  aside,
  children,
  className = '',
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card p-5 sm:p-7 ${className}`}>
      {title !== undefined && (
        <div className={`flex items-start gap-3.5 ${children === undefined ? '' : 'mb-5'}`}>
          {icon && (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-wash text-ink">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1 self-center">
            <h2 className="text-[17px] leading-snug font-semibold tracking-tight text-ink">{title}</h2>
            {description && <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
          </div>
          {aside && <div className="shrink-0 self-center">{aside}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Field({
  label,
  hint,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <input className={`input ${className}`} {...rest} />
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export type Tone = 'info' | 'ok' | 'warn' | 'bad';

const NOTE_STYLES: Record<Tone, { box: string; icon: string; Icon: typeof InfoIcon }> = {
  info: { box: 'border-line bg-wash/70', icon: 'text-ink-2', Icon: InfoIcon },
  ok: { box: 'border-ok-line bg-ok-soft', icon: 'text-ok', Icon: CheckCircleIcon },
  warn: { box: 'border-warn-line bg-warn-soft', icon: 'text-warn', Icon: AlertIcon },
  bad: { box: 'border-bad-line bg-bad-soft', icon: 'text-bad', Icon: AlertCircleIcon },
};

export function Note({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  const { box, icon, Icon } = NOTE_STYLES[tone];
  return (
    <div className={`flex gap-3 rounded-lg border px-4 py-3.5 text-sm leading-relaxed text-ink ${box}`}>
      <Icon size={18} className={`mt-0.5 ${icon}`} />
      <div className="min-w-0 flex-1 [&_.font-semibold]:text-ink">{children}</div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-sm leading-relaxed text-muted" role="status">
      <span className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-line-strong border-t-ink" />
      {label}
    </span>
  );
}

/** A whole-area wait (first load of a screen). */
export function Loading({ label }: { label: string }) {
  return (
    <div className="card flex items-center justify-center px-5 py-14">
      <Spinner label={label} />
    </div>
  );
}

export const CONFIRMING_TEXT =
  'Waiting for the network to confirm — usually about 4 minutes on Gnosis, 15–20 minutes on Sepolia. You can close this page; we pick up where you left off.';

/**
 * A just-sent step (or a fresh deployment) is not confirmed by the network
 * yet. A transient wait, never a failure — whoever renders this keeps
 * polling and the page moves on by itself once the network catches up.
 * `lead` says what was sent ("Your committee was created.").
 */
export function ConfirmingNote({ lead }: { lead?: string }) {
  return (
    <div role="status" className="overflow-hidden rounded-lg border border-info-line bg-info-soft text-sm leading-relaxed">
      <div className="flex gap-3 px-4 py-3.5">
        <span className="relative mt-0.5 flex size-[18px] shrink-0 items-center justify-center text-info">
          <span className="absolute inset-0 animate-ping rounded-full bg-info/20" />
          <ClockIcon size={18} />
        </span>
        <div className="min-w-0 flex-1">
          {lead && <p className="font-semibold text-ink">{lead}</p>}
          <p className="text-ink-2">{CONFIRMING_TEXT}</p>
        </div>
      </div>
      <div className="h-0.5 overflow-hidden bg-info-line/70" aria-hidden="true">
        <div className="h-full w-1/3 animate-sweep bg-info/70" />
      </div>
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  return (
    <div>
      {label && <div className="mb-2 text-sm text-muted">{label}</div>}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-wash ring-1 ring-line ring-inset">
        {value === null ? (
          <div className="h-full w-1/3 animate-sweep rounded-full bg-ink" />
        ) : (
          <div
            className="h-full rounded-full bg-ink transition-all"
            style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
          />
        )}
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
      {copied ? <CheckIcon size={17} className="text-ok" /> : <CopyIcon size={17} />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/** "Details for auditors" — collapsed technical values, out of the main flow. */
export function Disclosure({ summary = 'Details for auditors', children }: { summary?: string; children: ReactNode }) {
  return (
    <details className="group mt-4 text-xs text-muted">
      <summary className="inline-flex cursor-pointer items-center gap-1 rounded font-medium select-none hover:text-ink">
        <ChevronRightIcon size={14} className="transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="mt-2 rounded-lg border border-line bg-wash/60 p-3 font-mono leading-relaxed break-all text-ink-2">
        {children}
      </div>
    </details>
  );
}

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'dark';

const BADGE_STYLES: Record<BadgeTone, string> = {
  neutral: 'border-line bg-wash text-ink-2',
  ok: 'border-ok-line bg-ok-soft text-ok',
  warn: 'border-warn-line bg-warn-soft text-warn',
  bad: 'border-bad-line bg-bad-soft text-bad',
  info: 'border-info-line bg-info-soft text-info',
  dark: 'border-accent bg-accent text-white',
};

/** A short status label ("Joined", "Key ready"). */
export function Badge({ tone = 'neutral', dot = false, children }: { tone?: BadgeTone; dot?: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs leading-5 font-medium whitespace-nowrap ${BADGE_STYLES[tone]}`}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}

export type StepState = 'done' | 'current' | 'todo';
export interface Step {
  label: string;
  state: StepState;
}

/**
 * Where a committee stands in its life: numbered dots joined by a line, labels from `sm` up and
 * a "Step 3 of 6" line on phones.
 */
export function Steps({ steps, label }: { steps: Step[]; label: string }) {
  const current = steps.findIndex((s) => s.state === 'current');
  const allDone = steps.every((s) => s.state === 'done');
  const at = current >= 0 ? current : allDone ? steps.length - 1 : 0;
  return (
    <div aria-label={label} role="group" className="px-1">
      <ol className="flex items-start">
        {steps.map((s, i) => (
          <li
            key={s.label}
            aria-current={s.state === 'current' ? 'step' : undefined}
            className="relative flex flex-1 flex-col items-center text-center"
          >
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`absolute top-3.5 right-1/2 h-0.5 w-full -translate-y-1/2 ${
                  s.state === 'todo' ? 'bg-line' : 'bg-ink'
                }`}
              />
            )}
            <span
              className={`relative z-10 flex size-7 items-center justify-center rounded-full text-xs font-semibold ring-4 ring-white ${
                s.state === 'done'
                  ? 'bg-ink text-white'
                  : s.state === 'current'
                    ? 'border-2 border-ink bg-white text-ink'
                    : 'border border-line-strong bg-white text-faint'
              }`}
            >
              {s.state === 'done' ? <CheckIcon size={14} strokeWidth={2.5} /> : i + 1}
            </span>
            <span
              className={`sr-only max-w-28 text-xs leading-tight sm:not-sr-only sm:mt-2 sm:block ${
                s.state === 'current' ? 'font-semibold text-ink' : s.state === 'done' ? 'text-ink-2' : 'text-faint'
              }`}
            >
              {s.label}
              {s.state === 'done' && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-center text-sm text-muted sm:hidden" aria-hidden="true">
        {allDone ? (
          <span className="font-semibold text-ink">All done</span>
        ) : (
          <>
            Now: <span className="font-semibold text-ink">{steps[at]?.label}</span>
          </>
        )}
      </p>
    </div>
  );
}

/** The top of a screen: a small kicker, the title, an optional status badge and a short lead. */
export function PageHeader({
  eyebrow,
  title,
  badge,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-1">
      {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight text-ink sm:text-[28px]">{title}</h1>
        {badge}
      </div>
      {children && <div className="mt-2 max-w-2xl text-[15px] leading-relaxed text-muted">{children}</div>}
    </header>
  );
}

/** "any t of n": n small key dots, t of them filled. */
export function KeyDots({ t, n }: { t: number; n: number }) {
  const shown = Math.max(0, Math.min(16, n));
  return (
    <span className="inline-flex shrink-0 flex-wrap items-center gap-1" aria-hidden="true">
      {Array.from({ length: shown }, (_, i) => (
        <span
          key={i}
          className={`size-3 rounded-full ${i < t ? 'bg-ink' : 'border-[1.5px] border-line-strong bg-white'}`}
        />
      ))}
    </span>
  );
}

/** A bordered list whose rows are separated by hairlines. */
export function List({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <ul className={`divide-y divide-line overflow-hidden rounded-lg border border-line ${className}`}>{children}</ul>;
}

/** A row of label + value for review summaries. */
export function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex gap-3 py-3 first:pt-0 last:pb-0">
      <span className="mt-0.5 text-muted">{icon}</span>
      <div className="min-w-0 flex-1 text-[15px] leading-relaxed">{children}</div>
    </li>
  );
}

/** A thin, decorative fill bar under a count that is already spelled out in words. */
export function Meter({ value, className = 'mt-4' }: { value: number; className?: string }) {
  return (
    <div className={`h-1 w-full overflow-hidden rounded-full bg-wash ring-1 ring-line ring-inset ${className}`} aria-hidden="true">
      <div
        className="h-full rounded-full bg-ink transition-all duration-500"
        style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
      />
    </div>
  );
}
