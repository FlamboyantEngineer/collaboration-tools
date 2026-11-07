#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const targets = ['coverage/', 'test-results/', 'node_modules/.cache/', 'node_modules/.vite/'];

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

git(['rev-parse', '--verify', 'refs/remotes/origin/dev']);
if (git(['branch', '--list', 'dev'])) {
  git(['switch', 'dev']);
  git(['branch', '--set-upstream-to=origin/dev', 'dev']);
} else {
  git(['switch', '--create', 'dev', '--track', 'origin/dev']);
}

const branches = git(['for-each-ref', '--format=%(refname:lstrip=2)', 'refs/heads/'])
  .split('\n')
  .filter((branch) => branch && branch !== 'dev');
if (branches.length > 0) git(['branch', '-D', '--', ...branches]);

for (const target of targets) {
  rmSync(new URL(`../${target}`, import.meta.url), { recursive: true, force: true });
}

console.log(
  'Switched to dev, removed other local branches, test reports, coverage and tool caches.',
);
