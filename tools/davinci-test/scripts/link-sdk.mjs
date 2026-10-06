#!/usr/bin/env node
/**
 * Points node_modules/@vocdoni/davinci-sdk at a local, built davinci-sdk checkout:
 * DAVINCI_SDK_DIR, or by default a `davinci-sdk` checkout next to this repository (the main
 * checkout's parent directory, also from a git worktree). The SDK is consumed from its `dist/`,
 * so build it there first (`yarn install && yarn build`, yarn 1).
 *
 * node_modules/ethers is linked to the SDK's own ethers: one copy, so the Wallet and provider
 * this app builds are the classes the SDK type-checks and `instanceof`-checks against.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(pkgDir, '..', '..');

function defaultSdkDir() {
  let root = repoRoot;
  try {
    const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    root = path.dirname(common);
  } catch {
    // not a git checkout: use the directory layout
  }
  return path.join(root, '..', 'davinci-sdk');
}

const sdkDir = path.resolve(process.env.DAVINCI_SDK_DIR || defaultSdkDir());
const fail = (msg) => {
  console.error(`link-sdk: ${msg}`);
  process.exit(1);
};

const manifest = path.join(sdkDir, 'package.json');
if (!existsSync(manifest)) fail(`no davinci-sdk checkout at ${sdkDir}; set DAVINCI_SDK_DIR`);
const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
if (name !== '@vocdoni/davinci-sdk') fail(`${sdkDir} is ${name}, not @vocdoni/davinci-sdk`);
if (!existsSync(path.join(sdkDir, 'dist', 'index.mjs')) || !existsSync(path.join(sdkDir, 'dist', 'index.d.ts'))) {
  fail(`${sdkDir} is not built: run \`yarn install && yarn build\` there`);
}

const ethersDir = path.join(sdkDir, 'node_modules', 'ethers');
if (!existsSync(path.join(ethersDir, 'package.json'))) fail(`${sdkDir} has no node_modules/ethers: run \`yarn install\` there`);

function link(name, target) {
  const at = path.join(pkgDir, 'node_modules', name);
  mkdirSync(path.dirname(at), { recursive: true });
  const st = lstatSync(at, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) unlinkSync(at);
  else if (st) rmSync(at, { recursive: true, force: true });
  symlinkSync(target, at, 'dir');
  console.log(`${name} -> ${target}`);
}

link('@vocdoni/davinci-sdk', sdkDir);
link('ethers', ethersDir);
