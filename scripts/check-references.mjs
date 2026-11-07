#!/usr/bin/env node
// Fails when any authored file (or file path) mentions a host application.
// The denylist is stored base64-encoded so the repository never contains the terms it forbids.
//
//   node scripts/check-references.mjs              scan tracked and untracked, non-ignored files
//   node scripts/check-references.mjs --dir <path> scan every file under <path> (e.g. an unpacked tarball)
//   node scripts/check-references.mjs --encode <regex> [flags]   print a denylist entry
//   --denylist <path> reads another denylist file of the same shape (the script's own tests use one)

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { option, relativePosix, reportProblems, root, walk } from './lib/script.mjs';

const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|wasm|mp4|webm)$/i;
// Generated third-party metadata, not authored content.
const GENERATED = new Set(['package-lock.json']);

const args = process.argv.slice(2);

if (args[0] === '--encode') {
  const [, source, flags = 'i'] = args;
  if (!source) {
    console.error('Usage: check-references.mjs --encode <regex> [flags]');
    process.exit(2);
  }
  new RegExp(source, flags);
  console.log(JSON.stringify({ source: Buffer.from(source).toString('base64'), flags }));
  process.exit(0);
}

function loadDenylist() {
  const denylistPath = resolve(
    option('denylist', join(root, 'scripts', 'reference-denylist.json')),
  );
  const entries = JSON.parse(readFileSync(denylistPath, 'utf8'));
  return entries.map((entry, index) => ({
    index,
    pattern: new RegExp(Buffer.from(entry.source, 'base64').toString('utf8'), entry.flags + 'g'),
  }));
}

function listFiles() {
  const dirOption = option('dir');
  if (dirOption !== undefined) {
    const dir = resolve(dirOption);
    return { base: dir, files: walk(dir).map((file) => relativePosix(dir, file)) };
  }
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  const files = output.split('\0').filter((file) => file && !GENERATED.has(file));
  return { base: root, files };
}

function lineOf(text, offset) {
  return text.slice(0, offset).split('\n').length;
}

const denylist = loadDenylist();
const { base, files } = listFiles();
const findings = [];

for (const file of files) {
  for (const { index, pattern } of denylist) {
    pattern.lastIndex = 0;
    if (pattern.test(file)) findings.push(`${file}: path matches denylist entry #${index}`);
  }
  if (BINARY.test(file)) continue;
  let text;
  try {
    text = readFileSync(join(base, file), 'utf8');
  } catch {
    continue;
  }
  for (const { index, pattern } of denylist) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      findings.push(`${file}:${lineOf(text, match.index)}: matches denylist entry #${index}`);
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
}

reportProblems(findings, {
  heading: 'Host references found. Rewrite these in neutral terms',
  hint: 'Decode an entry with: node -e "console.log(Buffer.from(process.argv[1], \'base64\').toString())" <source>',
  success: `No host references in ${files.length} files (${denylist.length} denylist entries).`,
});
