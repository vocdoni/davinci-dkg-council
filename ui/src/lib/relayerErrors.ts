/**
 * Relayer refusals in plain language (architecture §6.5 copy rules). The
 * screens show `That did not work: <message>.`, so each message is a sentence
 * fragment that says what happened and what the person can do about it.
 */

/** The network refused a submitted action (as opposed to a slow or unreachable relayer). */
export class TxRejectedError extends Error {
  constructor(readonly reason?: string) {
    super(reason ? `the update was rejected: ${reason}` : 'the update was rejected');
    this.name = 'TxRejectedError';
  }
}

/** The relayer's error codes (relayer/README.md), as the SDK's RelayerError carries them. */
const PLAIN: Record<string, string> = {
  INVALID_ACTION: 'our service could not read this request — reload the page and try again',
  BAD_SIGNATURE: 'our service could not confirm this request came from your key — reload the page and try again',
  WRONG_CHAIN:
    'this copy of the app was made for a different public record — open the link you were given for your committee',
  UNSUPPORTED_MANAGER:
    'this committee was made with a different copy of this app — open the link you were given for it',
  SIMULATION_REVERTED: 'the public record does not accept this step right now',
  RATE_LIMITED: 'too many requests at once — wait a minute and try again',
  TX_FAILED: 'the update did not go through — please try again',
  INTERNAL: 'our service ran into a problem — please try again in a moment',
  NOT_FOUND: 'our service does not know this update — please try again',
  UNAUTHORIZED: 'our service only takes new committees from approved organizers — ask whoever runs this app for access',
  NOT_SPONSORED: 'our service does not cover this committee — ask whoever runs this app',
  QUOTA_EXCEEDED: 'this committee has used up what our service covers for this step — ask whoever runs this app',
  CONFLICT: 'a different version of this same step is already on its way — wait a minute, then reload the page',
  BUDGET_EXHAUSTED: 'our service has used up what it covers for today — please try again later',
  BUSY: 'our service is busy right now — try again in a moment',
  FORBIDDEN_ORIGIN: 'our service does not accept requests from this page’s address — please tell whoever runs this app',
  UNSUPPORTED_MEDIA_TYPE: 'our service refused the request format — reload the page to get the current app',
  TIMEOUT: 'our service did not answer in time — the step may still go through; reload the page in a minute to see where things stand',
};

interface CodedError {
  code: string;
  detail?: string;
}

const isRelayerError = (err: unknown): err is Error & CodedError & { httpStatus?: number } =>
  err instanceof Error && err.name === 'RelayerError' && typeof (err as Partial<CodedError>).code === 'string';

/** The SDK's RelayersUnavailableError: no relayer of the configured list took the request. */
const isPoolError = (err: unknown): err is Error & { failures: { url: string; error: unknown }[] } =>
  err instanceof Error &&
  err.name === 'RelayersUnavailableError' &&
  Array.isArray((err as { failures?: unknown }).failures);

/** What fetch rejects with when the request got no answer (Chromium, Firefox, Safari, Node). */
const NETWORK_FAILURE = /^(Failed to fetch|NetworkError when attempting to fetch resource|Load failed|fetch failed)/;

/** The relayer could not be reached or is not working right now (as opposed to answering "no"). */
const unreachable = (err: unknown): boolean =>
  (err instanceof TypeError && NETWORK_FAILURE.test(err.message)) ||
  (isRelayerError(err) &&
    (err.code === 'INTERNAL' || err.code === 'BUSY' || err.code === 'TIMEOUT' || (err.httpStatus ?? 0) >= 500));

/** The contract's refusal name from a SIMULATION_REVERTED detail such as `DuplicateParticipant()`. */
const revertName = (detail: string | undefined): string | undefined => /^([A-Za-z_]\w*)\(/.exec(detail ?? '')?.[1];

const RACE = 'someone else already completed this step — nothing to do';

/** Common contract refusals as plain sentences (CouncilTypes.sol names). */
const REVERTS: Record<string, string> = {
  DuplicateParticipant:
    'you have already joined — maybe on another device or an earlier try; restore from your kit instead',
  InviteConsumed: 'this invitation was already used — if that was you on another device, restore from your kit',
  AlreadyDealt: 'your contribution is already in — nothing more to do',
  AlreadyPartial: 'you already turned your key for this vote — nothing more to do',
  AlreadyBound: RACE,
  AlreadyRequested: RACE,
  AlreadyListed: RACE,
  FieldCompleted: RACE,
  CeremonyExists: RACE,
  WrongPhase: 'this step is no longer open — reload the page to see where things stand',
  Expired: 'this request took too long to arrive — try the step again',
};

/**
 * The contract refusal behind a submission error (`WrongPhase` for a SIMULATION_REVERTED
 * `WrongPhase()`), plain-language wrapper or not; undefined for anything else.
 */
export function submitRevertName(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    if (isRelayerError(cur)) return cur.code === 'SIMULATION_REVERTED' ? revertName(cur.detail) : undefined;
    cur = cur.cause;
  }
  return undefined;
}

/**
 * An Error whose message is safe to show as-is. Relayer refusals become plain
 * sentences (a known contract refusal gets its own sentence; an unknown one
 * keeps its name in parentheses for whoever debugs it); a network failure
 * says the service could not be reached; anything else passes through.
 */
export function plainSubmitError(err: unknown): Error {
  if (isPoolError(err)) {
    const { failures } = err;
    const only = failures.length === 1 ? failures[0] : undefined;
    // One configured relayer: exactly the message that relayer's answer gets.
    if (only) return new Error(plainSubmitError(only.error).message, { cause: err });
    if (failures.every((f) => unreachable(f.error))) {
      // No answer is not "not sent": a service may have carried the step and lost its reply.
      return new Error(
        `none of our ${failures.length} services answered right now — reload the page in a minute to see whether the step went through, and if not, try again; if it keeps failing, tell whoever runs this app`,
        { cause: err },
      );
    }
    const answered = failures.find((f) => !unreachable(f.error));
    return new Error(`${plainSubmitError(answered?.error).message} (our other services could not take it either)`, {
      cause: err,
    });
  }
  if (isRelayerError(err)) {
    const plain = PLAIN[err.code] ?? PLAIN.INTERNAL;
    const name = err.code === 'SIMULATION_REVERTED' ? revertName(err.detail) : undefined;
    if (name && REVERTS[name]) return new Error(REVERTS[name], { cause: err });
    return new Error(name ? `${plain} (${name})` : plain, { cause: err });
  }
  if (err instanceof TypeError && NETWORK_FAILURE.test(err.message)) {
    return new Error('we could not reach our service — check your connection and try again', { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}
