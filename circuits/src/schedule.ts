// Reference implementation of the protocol v2 phase policies (docs/protocol.md §8.1 create-time
// validation, §8.2/§8.3 registration close, §8.4 abort/finalize, §8.7 decryption opening). Used
// only by the vector generator (tests/vectors/schedule.json). Error names and their precedence are
// the CouncilManager's.
import { PHASE_MODES, MIN_DEALING_DURATION, MAX_DEALING_DURATION } from "./protocol.ts";

export const U64_MAX = (1n << 64n) - 1n;
const { Manual, Scheduled } = PHASE_MODES;

export type Policy = {
  registrationMode: number;
  registrationDeadline: bigint;
  dealingDuration: bigint;
  decryptionMode: number;
  decryptionOpenAt: bigint;
  manualDecryptionFallbackAt: bigint;
};

export type CreateResult = "ok" | "BadSchedule" | "BadDuration";

/** §8.1 policy validation at `now` (signature, id, threshold and invites assumed valid). */
export function validateCreate(p: Policy, now: bigint): CreateResult {
  if (p.dealingDuration < BigInt(MIN_DEALING_DURATION) || p.dealingDuration > BigInt(MAX_DEALING_DURATION)) {
    return "BadDuration";
  }
  const modeOk = (m: number) => m === Manual || m === Scheduled;
  if (!modeOk(p.registrationMode) || !modeOk(p.decryptionMode)) return "BadSchedule";
  const R = p.registrationDeadline;
  if (p.registrationMode === Scheduled) {
    if (R <= now) return "BadSchedule";
  } else if (R !== 0n && R <= now) {
    return "BadSchedule";
  }
  if (R !== 0n && R + p.dealingDuration > U64_MAX) return "BadSchedule";
  if (p.decryptionMode === Scheduled) {
    if (p.decryptionOpenAt <= now || p.manualDecryptionFallbackAt !== 0n) return "BadSchedule";
  } else {
    if (p.decryptionOpenAt !== 0n) return "BadSchedule";
    if (p.manualDecryptionFallbackAt !== 0n && p.manualDecryptionFallbackAt <= now) return "BadSchedule";
  }
  if (p.registrationMode === Scheduled) {
    const end = R + p.dealingDuration;
    if (p.decryptionMode === Scheduled && p.decryptionOpenAt <= end) return "BadSchedule";
    if (p.manualDecryptionFallbackAt !== 0n && p.manualDecryptionFallbackAt <= end) return "BadSchedule";
  }
  return "ok";
}

export type RegistrationState = {
  registrationMode: number;
  registrationDeadline: bigint;
  dealingDuration: bigint;
  threshold: number;
  joined: number;
};

/** §8.2: joining open (phase Registration, roster not full). */
export const joinResult = (s: RegistrationState, now: bigint): "ok" | "RegistrationEnded" =>
  s.registrationDeadline === 0n || now < s.registrationDeadline ? "ok" : "RegistrationEnded";

/** §8.3 organizer close (participantCount == joined). */
export function closeRegistrationResult(
  s: RegistrationState,
  now: bigint,
): { result: "ok" | "WrongMode" | "RegistrationEnded" | "BelowThreshold"; dealingDeadline: bigint | null } {
  if (s.registrationMode === Scheduled) return { result: "WrongMode", dealingDeadline: null };
  if (s.registrationDeadline !== 0n && now >= s.registrationDeadline) return { result: "RegistrationEnded", dealingDeadline: null };
  if (s.joined < s.threshold) return { result: "BelowThreshold", dealingDeadline: null };
  return { result: "ok", dealingDeadline: now + s.dealingDuration };
}

/** §8.3 permissionless time-based close. */
export function closeRegistrationScheduledResult(
  s: RegistrationState,
  now: bigint,
): { result: "ok" | "WrongMode" | "RegistrationNotDue" | "Expired" | "BelowThreshold"; dealingDeadline: bigint | null } {
  const R = s.registrationDeadline;
  if (R === 0n) return { result: "WrongMode", dealingDeadline: null };
  if (now < R) return { result: "RegistrationNotDue", dealingDeadline: null };
  if (now > R + s.dealingDuration) return { result: "Expired", dealingDeadline: null };
  if (s.joined < s.threshold) return { result: "BelowThreshold", dealingDeadline: null };
  return { result: "ok", dealingDeadline: R + s.dealingDuration };
}

/** §8.4 abort during Registration. */
export function abortRegistrationResult(s: RegistrationState, now: bigint): "ok" | "AbortConditionNotMet" {
  const R = s.registrationDeadline;
  if (R === 0n) return "AbortConditionNotMet";
  return (now >= R && s.joined < s.threshold) || now > R + s.dealingDuration ? "ok" : "AbortConditionNotMet";
}

export type DealingState = { dealingDeadline: bigint; threshold: number; n: number; dealt: number };

/** §8.3 dealing acceptance window (a member that has not dealt yet). */
export const dealResult = (s: DealingState, now: bigint): "ok" | "Expired" => (now <= s.dealingDeadline ? "ok" : "Expired");

/** §8.4 finalize eligibility (unchanged from v1). */
export const finalizeResult = (s: DealingState, now: bigint): "ok" | "FinalizeConditionNotMet" =>
  s.dealt === s.n || (now > s.dealingDeadline && s.dealt >= s.threshold) ? "ok" : "FinalizeConditionNotMet";

/** §8.4 abort during Dealing. */
export const abortDealingResult = (s: DealingState, now: bigint): "ok" | "AbortConditionNotMet" =>
  now > s.dealingDeadline && s.dealt < s.threshold ? "ok" : "AbortConditionNotMet";

export type DecryptionState = {
  decryptionMode: number;
  decryptionOpenAt: bigint;
  manualDecryptionFallbackAt: bigint;
  manualOpenedAt: bigint;
};

/** §8.7 isDecryptionOpen for a Live ceremony. */
export function isDecryptionOpen(s: DecryptionState, now: bigint): boolean {
  if (s.decryptionMode === Scheduled) return now >= s.decryptionOpenAt;
  return s.manualOpenedAt !== 0n || (s.manualDecryptionFallbackAt !== 0n && now >= s.manualDecryptionFallbackAt);
}

/** §8.7 openDecryption on a Live ceremony with a valid organizer signature. */
export function openDecryptionResult(s: DecryptionState, now: bigint): "ok" | "WrongMode" | "AlreadyOpen" {
  if (s.decryptionMode === Scheduled) return "WrongMode";
  return isDecryptionOpen(s, now) ? "AlreadyOpen" : "ok";
}
