#!/usr/bin/env node
// Builds and checks the package once, then tags the version in package.json as `v<version>` on a
// release commit: the current commit plus the built `dist/`, with a manifest that has no `prepare`
// script. Installing the tag therefore installs no development dependencies and builds nothing.
// Packs the library tarball from the tree it tagged, for the GitHub Release.
// Run on `main`, up to date with `origin/main`, with a clean tree, after the version bump merged:
// no changed and no untracked files, which the build would compile into the tag without their
// source. The package check then runs again on the release tree itself before anything is tagged.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packTarball, runNpm } from './lib/npm.mjs';
import { root } from './lib/script.mjs';
import { extractTarGz } from './lib/tar.mjs';

const git = (args, options = {}) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options }).trim();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const manifestText = readFileSync(join(root, 'package.json'), 'utf8');
const { version } = JSON.parse(manifestText);
const tag = `v${version}`;

// Untracked files count: the build compiles the whole `src` directory. Ignored output does not.
const changes = git(['status', '--porcelain', '--untracked-files=all']);
if (changes) {
  fail(`Commit, stash or remove these changes and untracked files before releasing:\n${changes}`);
}
if (git(['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('Release from the main branch.');
git(['fetch', '--quiet', 'origin', 'main']);
if (git(['rev-parse', 'HEAD']) !== git(['rev-parse', 'origin/main'])) {
  fail('main must match origin/main: pull or push first.');
}
if (git(['tag', '--list', tag])) fail(`${tag} already exists.`);

for (const script of ['build', 'check:package']) {
  runNpm(['run', script], { cwd: root, stdio: 'inherit' });
}

/** The manifest the tag carries: the same, without the script that would build the package again. */
function releaseManifest() {
  const manifest = JSON.parse(manifestText);
  delete manifest.scripts.prepare;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// A separate index adds the ignored build output without touching the working tree's index.
const indexDir = mkdtempSync(join(tmpdir(), 'collab-release-'));
try {
  const env = { ...process.env, GIT_INDEX_FILE: join(indexDir, 'index') };
  git(['read-tree', 'HEAD'], { env });
  git(['add', '--force', '--', 'dist'], { env });
  const manifestBlob = git(['hash-object', '-w', '--stdin'], { input: releaseManifest() });
  git(['update-index', '--cacheinfo', `100644,${manifestBlob},package.json`], { env });
  const tree = git(['write-tree'], { env });
  const commit = git(['commit-tree', tree, '-p', 'HEAD', '-m', `Release ${tag}`]);

  // The tagged manifest omits prepare; pack that tree rather than the checkout's manifest.
  const archive = join(indexDir, 'release.tgz');
  const packageDir = join(indexDir, 'package');
  git(['archive', '--format=tar.gz', '--output', archive, commit]);
  mkdirSync(packageDir);
  extractTarGz(archive, packageDir);
  // The checks ran on the checkout; the tag carries this tree, so it is checked too.
  runNpm(['run', 'check:package', '--', '--dir', packageDir], { cwd: root, stdio: 'inherit' });
  const pack = packTarball(packageDir, root);
  git(['tag', '--annotate', tag, commit, '--message', tag]);
  console.log(
    `Tagged ${tag} on ${git(['rev-parse', '--short', `${tag}^{commit}`])} and packed ${pack.filename}.`,
  );
  console.log(
    `Publish with: git push origin ${tag}, then attach ${pack.filename} to the ${tag} GitHub Release.`,
  );
} finally {
  rmSync(indexDir, { recursive: true, force: true });
}
