import { RelayerError, RelayersUnavailableError } from '@vocdoni/davinci-dkg-council-sdk';
import { describe, expect, it } from 'vitest';
import { plainSubmitError } from '../src/lib/relayerErrors';

const CODES = [
  'INVALID_ACTION',
  'BAD_SIGNATURE',
  'WRONG_CHAIN',
  'UNSUPPORTED_MANAGER',
  'SIMULATION_REVERTED',
  'RATE_LIMITED',
  'TX_FAILED',
  'INTERNAL',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'NOT_SPONSORED',
  'QUOTA_EXCEEDED',
  'CONFLICT',
  'BUDGET_EXHAUSTED',
  'BUSY',
  'FORBIDDEN_ORIGIN',
  'UNSUPPORTED_MEDIA_TYPE',
  'TIMEOUT',
];

// architecture §6.5: words the app never uses.
const BANNED = /wallet|\bgas\b|\bsign|transaction|key pair|on-chain|relayer|[A-Z]{2,}_[A-Z]/i;

describe('plain relayer errors', () => {
  it.each(CODES)('%s reads as plain language', (code) => {
    const err = plainSubmitError(new RelayerError(code, 'technical detail', undefined, 400));
    expect(err.message).not.toMatch(BANNED);
    expect(err.message).not.toContain('technical detail');
    expect(err.message.length).toBeGreaterThan(20);
    expect(err.cause).toBeInstanceOf(RelayerError);
  });

  it('gives each code its own message', () => {
    const messages = CODES.map((c) => plainSubmitError(new RelayerError(c, '')).message);
    expect(new Set(messages).size).toBe(CODES.length);
  });

  it('keeps the contract refusal name of an unmapped reverted simulation', () => {
    const err = plainSubmitError(new RelayerError('SIMULATION_REVERTED', 'NotQualified()', '0x12345678'));
    expect(err.message).toBe('the public record does not accept this step right now (NotQualified)');
  });

  // Review P1-10: common refusals become plain sentences, no raw names.
  it.each([
    ['DuplicateParticipant()', /already joined .* restore from your kit/],
    ['InviteConsumed()', /invitation was already used/],
    ['AlreadyDealt()', /contribution is already in — nothing more to do/],
    ['AlreadyPartial()', /already turned your key for this vote/],
    ['AlreadyBound()', /someone else already completed this step — nothing to do/],
    ['WrongPhase()', /no longer open — reload the page/],
  ])('maps %s to a plain sentence', (detail, want) => {
    const err = plainSubmitError(new RelayerError('SIMULATION_REVERTED', detail, '0x12345678'));
    expect(err.message).toMatch(want);
    expect(err.message).not.toMatch(BANNED);
    expect(err.message).not.toContain('(');
  });

  describe('several relayers (failover pool)', () => {
    const down = new TypeError('Failed to fetch');
    const pool = (...errors: unknown[]) =>
      new RelayersUnavailableError(errors.map((error, i) => ({ url: `https://r${i}.example`, error })));

    it('all unreachable: says none answered, never that nothing was sent (a reply may have been lost)', () => {
      const err = plainSubmitError(
        pool(
          down,
          new RelayerError('BUSY', 'busy', undefined, 503),
          new RelayerError('INTERNAL', 'x', undefined, 500),
          new RelayerError('TIMEOUT', 'no answer'),
        ),
      );
      expect(err.message).toMatch(/^none of our 4 services answered right now — reload the page in a minute to see whether the step went through/);
      expect(err.message).not.toMatch(/nothing was sent/i);
      expect(err.message).not.toMatch(BANNED);
    });

    it('one answered with a refusal: that answer, plus that the others could not take it', () => {
      const err = plainSubmitError(pool(down, new RelayerError('BUDGET_EXHAUSTED', 'budget', undefined, 429)));
      expect(err.message).toBe(
        'our service has used up what it covers for today — please try again later (our other services could not take it either)',
      );
      expect(err.message).not.toMatch(BANNED);
    });

    it('a single configured relayer reads exactly as before', () => {
      expect(plainSubmitError(pool(down)).message).toBe(plainSubmitError(down).message);
    });
  });

  it('falls back to the generic message for an unknown code', () => {
    expect(plainSubmitError(new RelayerError('SOMETHING_NEW', 'x')).message).toBe(
      plainSubmitError(new RelayerError('INTERNAL', 'x')).message,
    );
  });

  it('says the service could not be reached on a network failure', () => {
    expect(plainSubmitError(new TypeError('Failed to fetch')).message).toMatch(/could not reach our service/);
  });

  it('does not mistake a programming error for a network failure', () => {
    const e = new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    expect(plainSubmitError(e)).toBe(e);
  });

  it('passes other errors through', () => {
    const e = new Error('the proof does not match');
    expect(plainSubmitError(e)).toBe(e);
    expect(plainSubmitError('odd').message).toBe('odd');
  });
});
