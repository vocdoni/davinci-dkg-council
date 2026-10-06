#!/usr/bin/env node
/**
 * davinci-council: create a DAVINCI process keyed by a Council ceremony, end it, read its
 * results. See README.md.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { DavinciCouncilApp, type AppConfig } from './app.js';

const USAGE = `usage: davinci-council <command> [options]

commands:
  create   --ceremony <bytes12> [--fields 4] [--max-value 1000000] [--max-voters 1000000]
           [--duration 3600] [--title <text>]
  end      --process <bytes31>
  results  --process <bytes31> [--finalize]

connection (flags, else the --config JSON file, else the environment):
  --config <file>      JSON: rpcUrl, registry, manager, organizerKey, ceremonyId, sequencerUrls, verify
  --rpc <url>          DAVINCI_RPC_URL
  --registry <addr>    DAVINCI_REGISTRY
  --manager <addr>     COUNCIL_MANAGER (checked against the registry's CouncilAdapter)
  --sequencer <url>    DAVINCI_SEQUENCER_URLS (comma-separated); none: a local stand-in
  --verify <mode>      DAVINCI_VERIFY: release (default) | off | <pins.json>
  the organizer key only from the config file or DAVINCI_ORGANIZER_KEY
  --json               one JSON object on stdout`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    rpc: { type: 'string' },
    registry: { type: 'string' },
    manager: { type: 'string' },
    sequencer: { type: 'string', multiple: true },
    verify: { type: 'string' },
    ceremony: { type: 'string' },
    process: { type: 'string' },
    fields: { type: 'string' },
    'max-value': { type: 'string' },
    'max-voters': { type: 'string' },
    duration: { type: 'string' },
    title: { type: 'string' },
    finalize: { type: 'boolean' },
    json: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

interface FileConfig extends Partial<Omit<AppConfig, 'verify'>> {
  ceremonyId?: string;
  verify?: AppConfig['verify'];
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

function loadConfig(): { app: AppConfig; ceremonyId?: string } {
  const file: FileConfig = flags.config ? (JSON.parse(readFileSync(flags.config, 'utf8')) as FileConfig) : {};
  const env = process.env;
  const need = (what: string, v: string | undefined): string => v || fail(`missing ${what}\n\n${USAGE}`);
  const verifyArg = flags.verify ?? env.DAVINCI_VERIFY;
  let verify: AppConfig['verify'] = file.verify;
  if (verifyArg === 'release' || verifyArg === 'off') verify = verifyArg;
  else if (verifyArg) verify = JSON.parse(readFileSync(verifyArg, 'utf8')) as AppConfig['verify'];
  const sequencerUrls =
    flags.sequencer ?? file.sequencerUrls ?? env.DAVINCI_SEQUENCER_URLS?.split(',').filter((u) => u.trim() !== '');
  const manager = flags.manager ?? file.manager ?? env.COUNCIL_MANAGER;
  return {
    app: {
      rpcUrl: need('--rpc / DAVINCI_RPC_URL', flags.rpc ?? file.rpcUrl ?? env.DAVINCI_RPC_URL),
      registry: need('--registry / DAVINCI_REGISTRY', flags.registry ?? file.registry ?? env.DAVINCI_REGISTRY),
      organizerKey: need('the organizer key (DAVINCI_ORGANIZER_KEY)', file.organizerKey ?? env.DAVINCI_ORGANIZER_KEY),
      ...(manager && { manager }),
      ...(sequencerUrls?.length && { sequencerUrls }),
      ...(verify && { verify }),
    },
    ceremonyId: flags.ceremony ?? file.ceremonyId ?? env.COUNCIL_CEREMONY_ID,
  };
}

const int = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`--${name} must be a positive integer`);
  return n;
};

// bigints as decimal strings
const toJson = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));

async function run(): Promise<void> {
  const command = positionals[0];
  if (flags.help || !command) {
    console.log(USAGE);
    return;
  }
  if (!['create', 'end', 'results'].includes(command)) fail(`unknown command ${command}\n\n${USAGE}`);
  const { app: config, ceremonyId } = loadConfig();
  const app = await DavinciCouncilApp.connect(config);
  const print = (human: string, obj: object) => console.log(flags.json ? toJson(obj) : human);
  try {
    if (command === 'create') {
      if (!ceremonyId) fail('missing --ceremony / COUNCIL_CEREMONY_ID');
      const p = await app.create({
        ceremonyId,
        fields: int('fields', flags.fields),
        maxValue: int('max-value', flags['max-value']),
        maxVoters: int('max-voters', flags['max-voters']),
        duration: int('duration', flags.duration),
        title: flags.title,
      });
      print(
        [
          `process      ${p.processId}`,
          `ceremony     ${p.ceremonyId}`,
          `request id   ${p.requestId}`,
          `key (TE)     x=${p.encryptionKey.x}`,
          `             y=${p.encryptionKey.y}`,
          `adapter      ${p.adapter}`,
          `tx           ${p.transactionHash}`,
        ].join('\n'),
        p,
      );
    } else {
      const pid = flags.process ?? fail('missing --process');
      if (command === 'end') {
        await app.end(pid);
        print(`process ${pid} ended`, { processId: pid, ended: true });
      } else {
        const r = await app.results(pid, { finalize: flags.finalize === true });
        const lines = [`process      ${pid}`, `state        ${r.state}`];
        if (r.values) lines.push(...r.values.map((v, i) => `field ${String(i).padStart(2)}     ${v}`));
        print(lines.join('\n'), r);
      }
    }
  } finally {
    await app.close();
  }
}

run().catch((err: unknown) => {
  const e = err as { message?: string; revertName?: string };
  const msg = e.message ?? String(err);
  if (flags.json) console.log(toJson({ error: msg, ...(e.revertName && { revertName: e.revertName }) }));
  console.error(`davinci-council: ${msg}`);
  process.exit(1);
});
