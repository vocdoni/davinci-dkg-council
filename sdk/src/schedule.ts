/**
 * Phase-policy scheduling helpers (protocol §8.1–§8.4, §8.7): creation-time
 * validation, the gate and "is due" predicates, and a plain-language status.
 *
 * These are pure mirrors for building UIs, pre-validating a CreateCeremony
 * and deciding when to submit the permissionless close/abort/finalize. They
 * are NOT the authority on a member path: before computing a partial, the
 * gate is read from the contract's `isDecryptionOpen` view through the
 * authenticated snapshot (§9.3), never recomputed from a local clock.
 *
 * All times are absolute uint64 Unix seconds except `dealingDuration` (a
 * duration); `now` is the timestamp of the block the caller reasons about.
 */

import { MAX_DEALING_DURATION, MAX_INVITES, MIN_DEALING_DURATION, Phase, PhaseMode } from './constants.js';

const UINT64_MAX = (1n << 64n) - 1n;

/** The immutable policy fields of a ceremony (CreateCeremony / PhasePolicyView). */
export interface SchedulePolicy {
  registrationMode: number;
  decryptionMode: number;
  registrationDeadline: bigint;
  dealingDuration: bigint;
  decryptionOpenAt: bigint;
  manualDecryptionFallbackAt: bigint;
}

/** Raised by `validateSchedule`; `code` names the contract error it mirrors. */
export class ScheduleError extends Error {
  constructor(
    readonly code: 'BadSchedule' | 'BadDuration' | 'BadThreshold' | 'NoInvites' | 'TooManyInvites',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/**
 * The §8.1 creation rules a CreateCeremony must satisfy at `now`
 * (= block.timestamp of the creating transaction). Throws ScheduleError.
 */
export function validateSchedule(p: SchedulePolicy, now: bigint): void {
  // The contract checks the duration before anything else — mirror its error selection.
  if (p.dealingDuration < MIN_DEALING_DURATION || p.dealingDuration > MAX_DEALING_DURATION) {
    throw new ScheduleError(
      'BadDuration',
      `dealingDuration must be between ${MIN_DEALING_DURATION}s and ${MAX_DEALING_DURATION}s (365 days)`,
    );
  }
  if (p.registrationMode !== PhaseMode.Manual && p.registrationMode !== PhaseMode.Scheduled) {
    throw new ScheduleError('BadSchedule', 'registrationMode must be Manual (0) or Scheduled (1)');
  }
  if (p.decryptionMode !== PhaseMode.Manual && p.decryptionMode !== PhaseMode.Scheduled) {
    throw new ScheduleError('BadSchedule', 'decryptionMode must be Manual (0) or Scheduled (1)');
  }
  if (p.registrationMode === PhaseMode.Scheduled) {
    if (p.registrationDeadline <= now) {
      throw new ScheduleError('BadSchedule', 'scheduled registrationDeadline must be in the future');
    }
  } else if (p.registrationDeadline !== 0n && p.registrationDeadline <= now) {
    throw new ScheduleError('BadSchedule', 'manual registration expiry must be 0 or in the future');
  }
  if (p.registrationDeadline !== 0n && p.registrationDeadline + p.dealingDuration > UINT64_MAX) {
    throw new ScheduleError('BadSchedule', 'registrationDeadline + dealingDuration overflows uint64');
  }
  if (p.decryptionMode === PhaseMode.Scheduled) {
    if (p.decryptionOpenAt <= now) {
      throw new ScheduleError('BadSchedule', 'scheduled decryptionOpenAt must be in the future');
    }
    if (p.manualDecryptionFallbackAt !== 0n) {
      throw new ScheduleError('BadSchedule', 'scheduled decryption must not set a manual fallback');
    }
  } else {
    if (p.decryptionOpenAt !== 0n) {
      throw new ScheduleError('BadSchedule', 'manual decryption must not set decryptionOpenAt');
    }
    if (p.manualDecryptionFallbackAt !== 0n && p.manualDecryptionFallbackAt <= now) {
      throw new ScheduleError('BadSchedule', 'manual fallback must be 0 or in the future');
    }
  }
  if (p.registrationMode === PhaseMode.Scheduled) {
    const dealingEnd = p.registrationDeadline + p.dealingDuration;
    const opening = p.decryptionMode === PhaseMode.Scheduled ? p.decryptionOpenAt : p.manualDecryptionFallbackAt;
    if (opening !== 0n && opening <= dealingEnd) {
      throw new ScheduleError(
        'BadSchedule',
        'a decryption date must be strictly later than registrationDeadline + dealingDuration',
      );
    }
  }
}

/** Non-schedule §8.1 bounds the SDK can check before signing (threshold, invites). */
export function validateCreateBounds(threshold: number, inviteKeys: readonly string[]): void {
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 16) {
    throw new ScheduleError('BadThreshold', 'threshold must be 1..16');
  }
  if (inviteKeys.length < 1) throw new ScheduleError('NoInvites', 'at least one invite key');
  if (inviteKeys.length > MAX_INVITES) {
    throw new ScheduleError('TooManyInvites', `at most ${MAX_INVITES} invite keys`);
  }
  const seen = new Set(inviteKeys.map((k) => k.toLowerCase()));
  if (seen.size !== inviteKeys.length) throw new ScheduleError('BadSchedule', 'duplicate invite key');
}

/** The ceremony state the predicates below read. */
export interface ScheduleState extends SchedulePolicy {
  phase: number;
  manualOpenedAt: bigint;
  dealingDeadline: bigint;
  joinedCount: number;
  threshold: number;
  n: number;
  qualCount: number;
}

/** The §8.7 gate predicate (local mirror — the snapshot reads the view instead). */
export function decryptionOpenAt(c: ScheduleState, now: bigint): boolean {
  if (c.phase !== Phase.Live) return false;
  if (c.decryptionMode === PhaseMode.Scheduled) return now >= c.decryptionOpenAt;
  return (
    c.manualOpenedAt !== 0n || (c.manualDecryptionFallbackAt !== 0n && now >= c.manualDecryptionFallbackAt)
  );
}

/** §8.2: joining is open (half-open window — closed at the cutoff instant). */
export function joinOpen(c: ScheduleState, now: bigint): boolean {
  return c.phase === Phase.Registration && (c.registrationDeadline === 0n || now < c.registrationDeadline);
}

/** §8.3: the organizer's manual `closeRegistration` would succeed at `now`. */
export function manualCloseAllowed(c: ScheduleState, now: bigint): boolean {
  return c.registrationMode === PhaseMode.Manual && joinOpen(c, now) && c.joinedCount >= c.threshold;
}

/** §8.4: `deal` is accepted at `now` (the dealing deadline is inclusive). */
export function dealOpen(c: ScheduleState, now: bigint): boolean {
  return c.phase === Phase.Dealing && now <= c.dealingDeadline;
}

/**
 * §8.3: the permissionless `closeRegistrationScheduled` would succeed at `now`.
 * Gated by a nonzero registrationDeadline (also set as the expiry of a manual
 * ceremony), not by the registration mode.
 */
export function scheduledCloseDue(c: ScheduleState, now: bigint): boolean {
  return (
    c.phase === Phase.Registration &&
    c.registrationDeadline !== 0n &&
    now >= c.registrationDeadline &&
    now <= c.registrationDeadline + c.dealingDuration &&
    c.joinedCount >= c.threshold
  );
}

/** §8.4: `abort` would succeed at `now`. */
export function abortDue(c: ScheduleState, now: bigint): boolean {
  if (c.phase === Phase.Registration && c.registrationDeadline !== 0n) {
    if (now >= c.registrationDeadline && c.joinedCount < c.threshold) return true;
    return now > c.registrationDeadline + c.dealingDuration;
  }
  if (c.phase === Phase.Dealing) return now > c.dealingDeadline && c.qualCount < c.threshold;
  return false;
}

/** §8.4: `finalize` would succeed at `now`. */
export function finalizeDue(c: ScheduleState, now: bigint): boolean {
  if (c.phase !== Phase.Dealing) return false;
  return (now > c.dealingDeadline && c.qualCount >= c.threshold) || (c.n > 0 && c.qualCount === c.n);
}

const dateOf = (ts: bigint): string => new Date(Number(ts) * 1000).toISOString();

/**
 * A plain-language, honest status line for UIs. Dates are shown as the
 * published absolute dates (UTC); the gate is described as policy, not a
 * cryptographic time lock.
 */
export function scheduleStatus(c: ScheduleState, now: bigint): string {
  switch (c.phase) {
    case Phase.Registration: {
      if (abortDue(c, now)) return 'registration failed: the window passed — anyone may abort';
      if (scheduledCloseDue(c, now)) {
        return 'registration ended: anyone may close it and start dealing';
      }
      const until =
        c.registrationDeadline === 0n ? 'until the organizer closes it' : `until ${dateOf(c.registrationDeadline)}`;
      return `registration open ${until} (${c.joinedCount}/${c.threshold} needed)`;
    }
    case Phase.Dealing:
      if (abortDue(c, now)) return 'dealing failed: deadline passed below threshold — anyone may abort';
      if (finalizeDue(c, now)) return 'dealing complete: anyone may finalize';
      return `dealing in progress until ${dateOf(c.dealingDeadline)} (${c.qualCount} dealt)`;
    case Phase.Live: {
      if (decryptionOpenAt(c, now)) return 'live: decryption is open';
      if (c.decryptionMode === PhaseMode.Scheduled) {
        return `live: decryption opens ${dateOf(c.decryptionOpenAt)} (policy, not a cryptographic time lock)`;
      }
      return c.manualDecryptionFallbackAt !== 0n
        ? `live: decryption opens when the organizer opens it, or ${dateOf(c.manualDecryptionFallbackAt)} at the latest`
        : 'live: decryption opens only when the organizer opens it (no fallback)';
    }
    case Phase.Aborted:
      return 'aborted';
    default:
      return 'unknown ceremony';
  }
}
