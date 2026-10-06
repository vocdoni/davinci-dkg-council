/**
 * Invite-fragment hygiene (finding 7): the secret is stripped from the
 * address bar synchronously at bootstrap — before config fetch or storage
 * init can run, hang or fail — kept in memory only, and scoped to the path
 * it arrived on.
 */

import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { captureInviteFragment, peekInviteFragment, resetInviteFragmentForTests } from '../src/lib/inviteCapture';

beforeEach(() => resetInviteFragmentForTests());
afterEach(() => vi.unstubAllGlobals());

describe('invite fragment capture', () => {
  it('strips synchronously and scopes the secret to its path', () => {
    window.history.replaceState(null, '', '/c/xyz#v1.0.abcdef');
    captureInviteFragment();
    expect(window.location.hash).toBe('');
    expect(peekInviteFragment('/c/xyz')).toBe('#v1.0.abcdef');
    expect(peekInviteFragment('/c/other')).toBeNull(); // path-scoped
  });

  it('ignores non-invite fragments', () => {
    window.history.replaceState(null, '', '/c/xyz#section');
    captureInviteFragment();
    expect(window.location.hash).toBe('#section');
    expect(peekInviteFragment('/c/xyz')).toBeNull();
  });

  it('keeps the secret out of the URL even when startup hangs forever', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})));
    window.history.replaceState(null, '', '/c/xyz#v1.0.deadbeef');
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );
    // The strip happened during the first synchronous render; the app is
    // still stuck on its loading screen.
    expect(window.location.hash).toBe('');
    await screen.findByText(/Opening/);
    expect(peekInviteFragment('/c/xyz')).toBe('#v1.0.deadbeef'); // memory only
  });

  it('keeps the secret out of the URL when startup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('boom'))));
    window.history.replaceState(null, '', '/c/xyz#v1.0.cafe');
    render(
      <BrowserRouter>
        <App />
      </BrowserRouter>,
    );
    expect(window.location.hash).toBe('');
    await screen.findByText(/not set up correctly/);
    expect(window.location.hash).toBe(''); // still gone after the error
  });
});
