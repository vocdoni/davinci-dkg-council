/** Minimal structured logging: one JSON object per line on stdout/stderr. */

export type Fields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

const line = (level: string, msg: string, fields?: Fields): string =>
  JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields }, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

export const jsonLogger: Logger = {
  info: (msg, fields) => console.log(line('info', msg, fields)),
  warn: (msg, fields) => console.warn(line('warn', msg, fields)),
  error: (msg, fields) => console.error(line('error', msg, fields)),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
