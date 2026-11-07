#!/usr/bin/env node
// Installs the package as an npm Git dependency into a clean temporary consumer, as a host installs a
// branch, and checks what npm prepared: every entry point imports, the public declarations
// type-check, and no development dependency was installed. Then it deletes node_modules and repeats
// the checks through `npm ci` with the consumer's lockfile. Each install uses an empty npm cache, so
// npm clones and prepares the package from source both times.
// The default is this checkout's HEAD commit, so commit the changes to check first. Git reads a
// private repository through its usual credential helpers.
//   node scripts/check-git-install.mjs [<git dependency>]
//   node scripts/check-git-install.mjs "git+https://github.com/FlamboyantEngineer/collaboration-tools.git#dev"

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNpm } from './lib/npm.mjs';
import { reportProblems, root } from './lib/script.mjs';

const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const PACKAGE = manifest.name;

/** The lowest version a peer range admits; the ranges are a caret range or one exact version. */
function minimum(name) {
  const version = /^\^?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(
    manifest.peerDependencies[name],
  )?.[1];
  if (!version) {
    throw new Error(
      `The ${name} peer range ${manifest.peerDependencies[name]} has no plain minimum`,
    );
  }
  return `${name}@${version}`;
}

const dependency =
  process.argv[2] ??
  `git+${pathToFileURL(root).href}#${execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()}`;
const workDir = mkdtempSync(join(tmpdir(), 'collab-git-install-'));
const consumer = join(workDir, 'consumer');

const files = {
  'package.json': JSON.stringify({ name: 'git-install-consumer', private: true, type: 'module' }),
  'load.mjs': `
import * as protocol from '${PACKAGE}/protocol';
import * as client from '${PACKAGE}/client';
import * as server from '${PACKAGE}/server';

const url = protocol.buildRoomUrl({ endpoint: 'wss://example.test/rooms', room: 'a', token: 't' });
if (protocol.parseRoomUrl(url)?.room !== 'a') throw new Error('protocol round trip failed: ' + url);
for (const [name, value] of [
  ['client.createRoomProvider', client.createRoomProvider],
  ['server.createMemoryPersistence', server.createMemoryPersistence],
]) {
  if (typeof value !== 'function') throw new Error(name + ' is not exported');
}
`,
  'consumer.ts': `
import type { RoomAccess } from '${PACKAGE}/protocol';
import type { RoomProviderOptions } from '${PACKAGE}/client';
import { createMemoryPersistence, type RoomPersistence } from '${PACKAGE}/server';

export const access: RoomAccess = 'read-only';
export const persistence: RoomPersistence = createMemoryPersistence();
// @ts-expect-error The declarations type the options, so an unknown option fails.
export const unknown: RoomProviderOptions = { notAnOption: true };
`,
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      target: 'ES2022',
      lib: ['ES2023', 'DOM'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    files: ['consumer.ts'],
  }),
};

const problems = [];

function npm(args) {
  runNpm([...args, '--no-audit', '--no-fund'], {
    cwd: consumer,
    stdio: 'inherit',
    // An empty cache per install, so npm prepares the package instead of reusing a packed copy.
    env: { ...process.env, npm_config_cache: mkdtempSync(join(workDir, 'cache-')) },
  });
}

function check(phase) {
  const installed = join(consumer, 'node_modules', ...PACKAGE.split('/'));
  for (const area of ['protocol', 'client', 'server']) {
    for (const file of [`dist/${area}/index.js`, `dist/${area}/index.d.ts`]) {
      if (!existsSync(join(installed, file)))
        problems.push(`${phase}: the installed package is missing ${file}`);
    }
  }
  for (const name of Object.keys(manifest.devDependencies ?? {})) {
    if (name in (manifest.peerDependencies ?? {})) continue;
    if (existsSync(join(consumer, 'node_modules', ...name.split('/')))) {
      problems.push(`${phase}: the development dependency ${name} was installed`);
    }
  }
  try {
    execFileSync('node', ['load.mjs'], { cwd: consumer, stdio: 'inherit' });
  } catch {
    problems.push(`${phase}: importing the entry points failed (see above)`);
  }
  try {
    execFileSync('node', [tsc, '-p', 'tsconfig.json'], { cwd: consumer, stdio: 'inherit' });
  } catch {
    problems.push(`${phase}: the public declarations do not type-check (see above)`);
  }
}

try {
  mkdirSync(consumer);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(consumer, name), text);

  console.log(`Installing ${dependency} with Node ${process.version}.`);
  npm(['install', dependency, ...Object.keys(manifest.peerDependencies ?? {}).map(minimum)]);
  check('npm install');

  rmSync(join(consumer, 'node_modules'), { recursive: true, force: true });
  npm(['ci']);
  check('npm ci');
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

reportProblems(problems, {
  heading: 'Git install problems',
  success: `${dependency} installs and prepares through npm install and npm ci.`,
});
