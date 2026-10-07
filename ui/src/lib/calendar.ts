/**
 * A calendar file (RFC 5545 iCalendar) reminding a member to check their recovery words before a
 * committee's results can be opened. Two events, so the reminder survives calendar apps that drop
 * imported alarms: "check your words" well before the opening date (two weeks, or halfway there
 * when it is closer), and the opening itself with an alarm the day before. Public data only: the
 * committee link carries no secret.
 */

import { PhaseMode, type PhasePolicyView } from '@vocdoni/davinci-dkg-council-sdk';

const DAY = 86_400;

/**
 * The date the results can be opened from, while it is still ahead: the scheduled opening, or the
 * manual safety date (the latest the organizer can leave it). Null once open, or without any date.
 */
export function upcomingOpening(policy: PhasePolicyView, nowSeconds: number): { at: number; scheduled: boolean } | null {
  if (policy.decryptionOpen) return null;
  if (policy.decryptionMode === (PhaseMode.Scheduled as number)) {
    const at = Number(policy.decryptionOpenAt);
    return at > nowSeconds ? { at, scheduled: true } : null;
  }
  if (policy.manualOpenedAt !== 0n || policy.manualDecryptionFallbackAt === 0n) return null;
  const at = Number(policy.manualDecryptionFallbackAt);
  return at > nowSeconds ? { at, scheduled: false } : null;
}

/** iCalendar UTC date-time: 20261007T120000Z. */
function icsTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** TEXT value escaping (RFC 5545 §3.3.11). */
function icsText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Fold a content line at 75 octets (RFC 5545 §3.1), never splitting a UTF-8 sequence. */
function fold(line: string): string {
  const enc = new TextEncoder();
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with one space
    if (curBytes + n > limit) {
      parts.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

export interface ReminderInput {
  /** When the results can be opened (unix seconds). */
  openingAt: number;
  /** The committee's display name. */
  committee: string;
  /** The committee page (no secret in it). */
  link: string;
  /** Stable id seed (the committee id). */
  uid: string;
  /** Now, unix seconds (tests). */
  now?: number;
}

/** When to check the words: two weeks before the opening, or halfway there when it is closer. */
export function checkWordsAt(openingAt: number, now: number): number {
  return openingAt - Math.min(14 * DAY, Math.max(0, Math.floor((openingAt - now) / 2)));
}

/** The .ics file content (CRLF line endings). */
export function reminderCalendar(input: ReminderInput): string {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const checkAt = checkWordsAt(input.openingAt, now);
  const stamp = icsTime(now);
  const where = `Open ${input.link} to check them and to take part.`;
  const event = (id: string, at: number, summary: string, description: string, alarm: string) => [
    'BEGIN:VEVENT',
    `UID:${id}-${input.uid}@davinci-dkg-council`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${icsTime(at)}`,
    'DURATION:PT30M',
    `SUMMARY:${icsText(summary)}`,
    `DESCRIPTION:${icsText(description)}`,
    `URL:${input.link}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(summary)}`,
    `TRIGGER:${alarm}`,
    'END:VALARM',
    'END:VEVENT',
  ];
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Vocdoni//DAVINCI DKG Council//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    ...event(
      'check-words',
      checkAt,
      `Check your recovery words (${input.committee})`,
      `The results of ${input.committee} can be opened on ${new Date(input.openingAt * 1000).toUTCString()}. ` +
        'Make sure you still have your twelve recovery words and that they are right: without them you cannot help open the results. ' +
        where,
      'PT0M',
    ),
    ...event(
      'opening',
      input.openingAt,
      `Results can be opened (${input.committee})`,
      `The results of ${input.committee} can be opened from now on. ${where}`,
      '-P1D',
    ),
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
