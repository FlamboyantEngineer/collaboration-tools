#!/usr/bin/env node
// Enforces the structural rules of docs/CODING-GUIDELINES.md that lint cannot see:
//   N1 kebab-case files and directories; S1 only `server/websocket/` imports a Node module or
//   `ws`, since everything else runs in a browser too, and only it imports itself; S2 `index.ts`
//   files only re-export; S3 `client/` and `server/` import `protocol/` and never each other,
//   `protocol/` imports neither, `testing/` may import all three and nothing imports it, and
//   library source never imports `test/` and no modules import each other in a cycle.

import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { relativePosix, reportProblems, root, walk } from './lib/script.mjs';

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+)*$/;
const AREAS = ['protocol', 'client', 'server', 'testing'];
/** The areas each area may import, besides itself. */
const ALLOWED = {
  protocol: [],
  client: ['protocol'],
  server: ['protocol'],
  testing: ['protocol', 'client', 'server'],
};
/** The one directory that runs only on Node: the WebSocket attachment's entry point. */
const NODE_ENTRY = 'src/server/websocket/';
const NODE_ONLY = new Set([...builtinModules, 'ws']);

const problems = [];
const rel = (path) => relativePosix(root, path);

for (const dir of ['src', 'test', 'scripts']) {
  for (const path of walk(join(root, dir), { directories: true })) {
    if (!KEBAB.test(basename(path)))
      problems.push(`${rel(path)}: file and directory names are kebab-case (N1)`);
  }
}

/** The area of a path under `src/`, such as `client` for `src/client/room-provider.ts`. */
function areaOf(path) {
  const [top, area] = rel(path).split('/');
  return top === 'src' && AREAS.includes(area ?? '') ? area : undefined;
}

/** The module specifiers a source file imports or re-exports, with whether each is a re-export. */
function specifiers(source) {
  const found = [];
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement);
    const isExport = ts.isExportDeclaration(statement);
    if ((isImport || isExport) && statement.moduleSpecifier) {
      found.push(/** @type {ts.StringLiteral} */ (statement.moduleSpecifier).text);
    }
  }
  return found;
}

function isReExportOnly(source) {
  return source.statements.every(
    (statement) => ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined,
  );
}

const sources = walk(join(root, 'src')).filter(
  (path) => path.endsWith('.ts') && !path.endsWith('.test.ts'),
);
/** Each library module and the library modules it imports. */
const graph = new Map();

for (const path of sources) {
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const area = areaOf(path);
  if (basename(path) === 'index.ts' && !isReExportOnly(source)) {
    problems.push(`${rel(path)}: an index.ts only re-exports with export … from (S2)`);
  }
  const targets = [];
  for (const specifier of specifiers(source)) {
    const bare = specifier.replace(/^node:/, '').split('/')[0] ?? '';
    if (!specifier.startsWith('.')) {
      const nodeOnly = specifier.startsWith('node:') || NODE_ONLY.has(bare);
      if (nodeOnly && !rel(path).startsWith(NODE_ENTRY)) {
        problems.push(`${rel(path)}: runs in a browser and cannot import ${specifier} (S1)`);
      }
      continue;
    }
    const target = resolve(dirname(path), specifier.replace(/\.js$/, '.ts'));
    const targetArea = areaOf(target);
    if (rel(target).startsWith(NODE_ENTRY) && !rel(path).startsWith(NODE_ENTRY)) {
      problems.push(`${rel(path)}: only ${NODE_ENTRY} imports its Node-only modules (S1)`);
    } else if (!rel(target).startsWith('src/')) {
      problems.push(`${rel(path)}: library source cannot import ${specifier} (S3)`);
    } else if (area && targetArea && targetArea !== area && !ALLOWED[area].includes(targetArea)) {
      problems.push(`${rel(path)}: ${area}/ cannot import ${targetArea}/ (S3)`);
    }
    targets.push(target);
  }
  graph.set(path, targets);
}

// Depth-first search; a module met again while still on the stack closes a cycle.
const state = new Map();
function visit(path, stack) {
  state.set(path, 'open');
  for (const target of graph.get(path) ?? []) {
    if (state.get(target) === 'open') {
      const cycle = [...stack.slice(stack.indexOf(target)), target].map(rel);
      problems.push(`import cycle (S3): ${cycle.join(' -> ')}`);
    } else if (!state.has(target) && graph.has(target)) {
      visit(target, [...stack, target]);
    }
  }
  state.set(path, 'done');
}
for (const path of graph.keys()) if (!state.has(path)) visit(path, [path]);

reportProblems(problems, {
  heading: 'Structure problems',
  success: `${sources.length} library modules follow the structure rules.`,
});
