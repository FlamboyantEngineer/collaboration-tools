// Gzipped tar archives in Node, so the scripts need no `tar` binary: writes ustar entries for
// regular files and directories, and reads them back, along with the pax and GNU long-name headers
// npm writes for long paths.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;

function writeField(header, offset, length, text) {
  header.write(text, offset, length, 'utf8');
}

function writeOctal(header, offset, length, value) {
  writeField(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

/** Splits a POSIX path into ustar's prefix and name fields, or throws when it does not fit. */
function splitName(path) {
  if (Buffer.byteLength(path) <= 100) return ['', path];
  for (let index = path.indexOf('/'); index !== -1; index = path.indexOf('/', index + 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return [prefix, name];
  }
  throw new Error(`${path} is too long for a tar entry`);
}

// Every entry is stamped with the time the archive was written.
const mtime = Math.floor(Date.now() / 1000);

function entryHeader(path, size, type, mode) {
  const header = Buffer.alloc(BLOCK);
  const [prefix, name] = splitName(path);
  writeField(header, 0, 100, name);
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, mtime);
  header.fill(' ', 148, 156);
  writeField(header, 156, 1, type);
  writeField(header, 257, 6, 'ustar\0');
  writeField(header, 263, 2, '00');
  writeField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function padding(size) {
  return Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
}

/** The archive paths under `entry`, relative to `cwd`, with forward slashes. */
function collect(cwd, entry) {
  const full = join(cwd, entry);
  const path = relative(cwd, full).split(sep).join('/');
  if (!statSync(full).isDirectory()) return [{ path, full }];
  return [
    { path: `${path}/`, full, isDirectory: true },
    ...readdirSync(full)
      .sort()
      .flatMap((name) => collect(cwd, join(entry, name))),
  ];
}

/** Writes `entries` (files or directories, relative to `cwd`) to the gzipped tar `archive`. */
export function createTarGz(archive, cwd, entries) {
  const chunks = [];
  for (const item of entries.flatMap((entry) => collect(cwd, entry))) {
    if (item.isDirectory) {
      chunks.push(entryHeader(item.path, 0, '5', 0o755));
      continue;
    }
    const data = readFileSync(item.full);
    chunks.push(entryHeader(item.path, data.length, '0', 0o644), data, padding(data.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  writeFileSync(archive, gzipSync(Buffer.concat(chunks)));
}

const readText = (buffer, offset, length) =>
  buffer
    .subarray(offset, offset + length)
    .toString('utf8')
    .replace(/\0.*$/s, '');

/** The `path` record of a pax extended header, if it has one. */
function paxPath(data) {
  for (const record of data.toString('utf8').split('\n')) {
    const match = record.match(/^\d+ path=(.*)$/s);
    if (match) return match[1];
  }
  return undefined;
}

/** Extracts the gzipped tar `archive` into `dir`, refusing entries that would land outside it. */
export function extractTarGz(archive, dir) {
  const buffer = gunzipSync(readFileSync(archive));
  let nextPath;
  for (let offset = 0; offset + BLOCK <= buffer.length;) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(readText(header, 124, 12).trim() || '0', 8);
    const type = readText(header, 156, 1) || '0';
    const data = buffer.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x' || type === 'L') {
      nextPath = type === 'x' ? paxPath(data) : readText(data, 0, size);
      continue;
    }
    const prefix = readText(header, 345, 155);
    const path = nextPath ?? (prefix ? `${prefix}/` : '') + readText(header, 0, 100);
    nextPath = undefined;
    const target = resolve(dir, path);
    const inside = relative(resolve(dir), target);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${path} leaves ${dir}`);
    if (type === '5') {
      mkdirSync(target, { recursive: true });
    } else if (type === '0') {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data);
    }
  }
}
