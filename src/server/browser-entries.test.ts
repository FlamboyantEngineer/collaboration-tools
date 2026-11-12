import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const NODE_ONLY = new Set([...builtinModules, 'ws']);
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every non-relative module that `entry` and the library modules it reaches import. */
function externalImports(entry: string): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const pending = [resolve(SRC, entry)];
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    if (seen.has(path)) continue;
    seen.add(path);
    for (const { fileName } of ts.preProcessFile(readFileSync(path, 'utf8')).importedFiles) {
      if (fileName.startsWith('.'))
        pending.push(resolve(dirname(path), fileName.replace(/\.js$/, '.ts')));
      else found.add(fileName);
    }
  }
  return found;
}

function nodeOnly(specifiers: Set<string>): string[] {
  return [...specifiers].filter(
    (specifier) =>
      specifier.startsWith('node:') || NODE_ONLY.has(specifier.split('/')[0] ?? specifier),
  );
}

describe('entry points that run in a browser', () => {
  it('COLLAB-SERVER-9.1 the server and testing entries reach no Node built-in and not ws', () => {
    expect(nodeOnly(externalImports('server/index.ts'))).toEqual([]);
    expect(nodeOnly(externalImports('testing/index.ts'))).toEqual([]);
  });

  it('COLLAB-SERVER-9.1 the WebSocket attachment keeps its Node imports in its own entry', () => {
    expect(nodeOnly(externalImports('server/websocket/index.ts'))).toEqual(
      expect.arrayContaining(['node:buffer', 'ws']),
    );
  });
});
