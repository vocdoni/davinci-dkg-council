/** Plain-language formatting helpers (copy rules, architecture §6.5). */

import type { Hex, Point } from '@vocdoni/davinci-dkg-council-sdk';
import { keccak256, toBytes } from 'viem';

/** A short, human-comparable identity code for a member (not a secret). */
export function identityCode(auth: Hex, key: Point): string {
  const digest = keccak256(toBytes(`${auth.toLowerCase()}:${key.x.toString(10)}:${key.y.toString(10)}`));
  return digest.slice(2, 10).toUpperCase();
}

/** Short form of a long id for display. */
export function shortId(id: string): string {
  return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** "any 3 of 5 together can open the results" */
export function thresholdSentence(t: number, n: number): string {
  return `any ${t} of ${n} together can open the results`;
}

const MINUTE = 60;
const HOUR = 3600;
const DAY = 86400;

/** Human countdown to a unix timestamp (seconds). */
export function timeLeft(deadline: number, now: number = Math.floor(Date.now() / 1000)): string {
  const s = deadline - now;
  if (s <= 0) return 'time is up';
  if (s < MINUTE) return 'less than a minute left';
  // Round once, then split: rounding the remainder alone gives "23 h 60 min".
  const minutes = Math.round(s / MINUTE);
  if (minutes < HOUR / MINUTE) return `about ${minutes} ${plural(minutes, 'minute')} left`;
  // Above ~23.5 h nobody plans by the hour any more — round to whole days.
  if (minutes >= 23.5 * 60) {
    const d = Math.max(1, Math.round(s / DAY));
    return `about ${d} ${plural(d, 'day')} left`;
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `about ${h} h ${m} min left` : `about ${h} ${plural(h, 'hour')} left`;
}

/** The organizer's local name for a vote, or "Vote #2 (0x…0003)". */
export function voteName(label: string | undefined, ordinal: number, processId: string): string {
  return label?.trim() ? label.trim() : `Vote #${ordinal} (${shortId(processId)})`;
}

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

export function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/** The same instant in UTC, for showing next to the local time. */
export function formatDateUTC(unixSeconds: number): string {
  const utc = new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  });
  return `${utc} UTC`;
}

/** Local time with the UTC equivalent in parentheses (skipped when identical). */
export function dateWithUtc(unixSeconds: number): string {
  const local = formatDate(unixSeconds);
  const utc = formatDateUTC(unixSeconds);
  return utc.startsWith(local) ? local : `${local} (${utc})`;
}

/** Count set bits of a small bitmap. */
export function bitCount(bitmap: number | bigint): number {
  let v = BigInt(bitmap);
  let c = 0;
  while (v > 0n) {
    c += Number(v & 1n);
    v >>= 1n;
  }
  return c;
}

/** 1-based indexes of set bits (bit i-1 = index i, the contract convention). */
export function bitIndexes(bitmap: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= 16; i++) if (bitmap & (1 << (i - 1))) out.push(i);
  return out;
}
