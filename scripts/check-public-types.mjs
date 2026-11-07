#!/usr/bin/env node
// Fails when an exported type names a library type that no entry point exports, so a host could not
// name the type of a value it passes or receives (coding guideline N5). Run after `npm run build`.
//   node scripts/check-public-types.mjs                 check dist/
//   node scripts/check-public-types.mjs --dir <path>    check another declaration directory

import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { option, reportProblems, root } from './lib/script.mjs';
import { findUnexportedTypes } from './lib/unexported-types.mjs';

const dirOption = option('dir');
const dir = dirOption === undefined ? join(root, 'dist') : resolve(dirOption);

if (!existsSync(dir)) {
  console.error(`${relative(root, dir) || dir} does not exist; run npm run build first.`);
  process.exit(1);
}

// The declaration files package.json exports, such as dist/client/index.d.ts.
const { exports } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const entries = Object.values(exports)
  .map((target) => (typeof target === 'string' ? null : target.types))
  .filter((types) => typeof types === 'string')
  .map((types) => join(dir, types.replace(/^\.\/dist\//, '')));

const unexported = findUnexportedTypes(dir, { entries });
reportProblems(unexported, {
  heading: `${unexported.length} public type(s) name a type no entry point exports`,
  hint: "Export the named type from its area's index.ts (coding guideline N5).",
  success: `Every type the ${entries.length} entry points' types name is exported.`,
});
