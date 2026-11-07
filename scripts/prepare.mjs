#!/usr/bin/env node
// npm runs `prepare` after `npm ci` in a checkout, when it prepares a git dependency and when it
// packs. Only the last two need the built package, and only they tell the script which directory
// they prepare (`npm_package_resolved`), so a checkout's install builds nothing. Packing with
// `--ignore-scripts` reuses the tree's existing build (UIC-LABS-1.4).

import { runNpm } from './lib/npm.mjs';

const isPreparingPackage = Boolean(process.env.npm_package_resolved);
const ignoresScripts = process.env.npm_config_ignore_scripts === 'true';

if (!isPreparingPackage || ignoresScripts) {
  console.log('prepare: nothing to build here; `npm run build:package` builds the package.');
} else {
  try {
    runNpm(['run', 'build:package'], { stdio: 'inherit' });
  } catch (error) {
    process.exitCode = /** @type {{ status?: number }} */ (error).status ?? 1;
  }
}
