// What every repository script shares: the repository root, a recursive file listing, command-line
// options and the problem report a check ends with.

import { readdirSync, statSync } from 'node:fs';
import path, { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, the directory that holds `scripts/`. */
export const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * Every file under `dir`, recursively, as full paths in a stable order; with `directories`, each
 * directory too, listed before its contents.
 * @param {string} dir
 * @param {{ directories?: boolean }} [options]
 * @returns {string[]}
 */
export function walk(dir, { directories = false } = {}) {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) return [full];
      return directories ? [full, ...walk(full, { directories })] : walk(full);
    });
}

/**
 * `to` relative to `from` with `/` separators on every platform, as the repository's path lists are
 * written. `paths` is the `node:path` flavour, so a test can pass `path.win32`.
 * @param {string} from
 * @param {string} to
 * @param {typeof path} [paths]
 * @returns {string}
 */
export function relativePosix(from, to, paths = path) {
  return paths.relative(from, to).split(paths.sep).join('/');
}

/**
 * The value given as `--name value` or `--name=value`, or `fallback`.
 * @template {string | undefined} [T=undefined]
 * @param {string} name
 * @param {T} [fallback]
 * @param {string[]} [args]
 * @returns {string | T}
 */
export function option(name, fallback, args = process.argv.slice(2)) {
  const inline = args.find((arg) => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const value = args[args.indexOf(`--${name}`) + 1];
  return args.includes(`--${name}`) && value !== undefined ? value : /** @type {T} */ (fallback);
}

/**
 * Whether `--name` was given.
 * @param {string} name
 * @param {string[]} [args]
 */
export function flag(name, args = process.argv.slice(2)) {
  return args.includes(`--${name}`);
}

/**
 * Ends a check: with no problems, prints `success` and returns; otherwise prints `heading`, each
 * problem indented, then `hint` when given, and exits with status 1.
 * @param {string[]} problems
 * @param {{ heading: string, hint?: string, success?: string }} report
 */
export function reportProblems(problems, { heading, hint, success }) {
  if (problems.length === 0) {
    if (success) console.log(success);
    return;
  }
  console.error(`${heading}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}
