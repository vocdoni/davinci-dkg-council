import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

/** The DAVINCI mark (the same square "D" as DAVINCI Elections) with the product name. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0 text-ink">
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <path
          d="M9 8h6.5c5 0 8.5 3.3 8.5 8s-3.5 8-8.5 8H9V8zm4 3.5v9h2.4c2.8 0 4.6-1.8 4.6-4.5s-1.8-4.5-4.6-4.5H13z"
          fill="#ffffff"
        />
      </svg>
      <span className="flex flex-col leading-none">
        <span className="text-[17px] font-medium tracking-[-0.01em] whitespace-nowrap text-ink">DAVINCI Council</span>
        {!compact && (
          <span className="mt-1 text-xs whitespace-nowrap text-muted">
            Election committees for DAVINCI
          </span>
        )}
      </span>
    </span>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
          <Link to="/" className="-m-1 rounded-lg p-1" aria-label="DAVINCI Council — start page">
            <Logo />
          </Link>
          <Link
            to="/restore"
            className="shrink-0 rounded-md px-2.5 py-2 text-sm font-medium whitespace-nowrap text-ink-2 transition-colors hover:bg-wash hover:text-ink"
          >
            Restore<span className="max-[399px]:hidden"> a key</span>
          </Link>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-12">{children}</main>
      <footer className="border-t border-line bg-white">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <p className="font-medium text-ink-2">DAVINCI Council · Election committees for DAVINCI</p>
            <p className="mt-1 text-[13px]">Each member’s key is made and kept in their own browser.</p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
            <a className="hover:text-ink" href="https://davinci.vote" target="_blank" rel="noreferrer">
              davinci.vote
            </a>
            <a className="hover:text-ink" href="https://vocdoni.io" target="_blank" rel="noreferrer">
              By Vocdoni
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

/** A centered column for a single flow screen. */
export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={`mx-auto w-full space-y-5 ${wide ? 'max-w-4xl' : 'max-w-3xl'}`}>{children}</div>;
}

/** A committee screen: the main column, and a side column for the kit and records from `lg` up. */
export function Dashboard({ header, main, aside }: { header: ReactNode; main: ReactNode; aside: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      {header}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_330px]">
        <div className="min-w-0 space-y-5">{main}</div>
        <aside className="min-w-0 space-y-5">{aside}</aside>
      </div>
    </div>
  );
}
