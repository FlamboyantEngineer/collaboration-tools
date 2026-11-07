#!/usr/bin/env node
// Checks the packed library as a host installs it. It packs the tree as built (`npm run build`)
// without running the package scripts, so it never rebuilds files that checks running beside it
// read. `--dir <path>` checks another package directory instead of the checkout, such as the release
// tree `npm run release` is about to tag. The tarball ships every entry point package.json exports,
// no tests, fixtures or scripts, and every source map in it resolves each of its sources to a file
// the tarball ships, or embeds it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { packTarball } from './lib/npm.mjs';
import { reportProblems, root } from './lib/script.mjs';
import { extractTarGz } from './lib/tar.mjs';

// Import attributes (`with { type: 'json' }`) need recent toolchains, so the build emits none.
const IMPORT_ATTRIBUTES =
  /\b(?:from\s*['"][^'"]+['"]|import\s*\(\s*['"][^'"]+['"]\s*,)\s*with\s*\{/;

const dirFlag = process.argv.indexOf('--dir');
/** The package directory to check: the checkout by default. */
const packageRoot = dirFlag === -1 ? root : resolve(process.argv[dirFlag + 1] ?? '');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

/** Every file an `exports` condition points at, such as `dist/client/index.js`. */
const exported = Object.values(manifest.exports)
  .flatMap((target) => (typeof target === 'string' ? [target] : Object.values(target)))
  .map((path) => path.replace(/^\.\//, ''));

if (!existsSync(join(packageRoot, 'dist'))) {
  console.error('dist/ is missing: run `npm run build` before checking the package.');
  process.exit(1);
}

const problems = [];
const workDir = mkdtempSync(join(tmpdir(), 'collab-package-'));

try {
  const pack = packTarball(packageRoot, workDir);
  const files = new Set(pack.files.map((file) => file.path));

  for (const required of new Set(['package.json', ...exported])) {
    if (!files.has(required)) problems.push(`tarball is missing ${required}`);
  }
  for (const file of files) {
    if (/\.test\.|(^|\/)(test|scripts)\//.test(file)) {
      problems.push(`tarball must not contain ${file}`);
    }
    if (file.endsWith('.js') && file.startsWith('dist/')) {
      const text = readFileSync(join(packageRoot, file), 'utf8');
      if (IMPORT_ATTRIBUTES.test(text)) problems.push(`${file} uses import attributes`);
    }
  }

  const extractDir = join(workDir, 'extract');
  mkdirSync(extractDir);
  extractTarGz(join(workDir, pack.filename), extractDir);
  const installed = join(extractDir, 'package');

  let mapSources = 0;
  const unresolved = [];
  for (const file of files) {
    if (!file.endsWith('.map')) continue;
    const map = JSON.parse(readFileSync(join(installed, file), 'utf8'));
    const base = resolve(installed, dirname(file), map.sourceRoot ?? '');
    for (const [index, source] of map.sources.entries()) {
      mapSources += 1;
      const target = resolve(base, source);
      const isShipped = !relative(installed, target).startsWith('..') && existsSync(target);
      if (!isShipped && typeof map.sourcesContent?.[index] !== 'string') {
        unresolved.push(`${file} -> ${source}`);
      }
    }
  }
  if (unresolved.length > 0) {
    problems.push(
      `${unresolved.length} source map references point at sources the tarball neither ships nor embeds, such as ${unresolved.slice(0, 3).join(', ')}`,
    );
  }

  try {
    execFileSync('node', [join(root, 'scripts', 'check-references.mjs'), '--dir', installed], {
      stdio: 'inherit',
    });
  } catch {
    problems.push('the packed tarball contains host references (see above)');
  }

  if (problems.length === 0) {
    console.log(
      `${pack.filename}: ${files.size} files, ${(pack.size / 1024).toFixed(0)} KiB packed, ${mapSources} source map references resolved.`,
    );
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

reportProblems(problems, { heading: 'Package problems' });
