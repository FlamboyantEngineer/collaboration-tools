#!/usr/bin/env node
// Validates specs/ against the format in specs/README.md:
//   - unique COLLAB- requirement IDs with Implementation: and Verification: lines;
//   - every requirement sits under its own group heading, numbered from 1 without gaps, and groups
//     ascend;
//   - every referenced path exists, and a referenced test names the requirement ID;
//   - every library source module (src/, tests and index.ts files aside) is the Implementation: of
//     some requirement.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { relativePosix, reportProblems, root, walk } from './lib/script.mjs';

const specsDir = join(root, 'specs');

const ID = String.raw`COLLAB-[A-Z0-9]+(?:-[A-Z0-9]+)*-T?\d+(?:\.\d+)?[a-z]?`;
const HEADING = new RegExp(`^(#{2,3}) (${ID}) - (.+)$`);
// The group and the number within it: COLLAB-ROOM-2 and COLLAB-ROOM-2.3.
const NUMBERS = /-(\d+)(?:\.(\d+))?[a-z]?$/;
const TEST_FILE = /\.test\.ts$/;

const problems = [];
const ids = new Map();
const implementationPaths = new Set();

function backticked(text) {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function checkRequirement(file, requirement) {
  const { id, lines } = requirement;
  const implementation = lines.find((line) => line.startsWith('Implementation:'));
  const verification = lines.find((line) => line.startsWith('Verification:'));
  if (!implementation) problems.push(`${file}: ${id} has no Implementation: line`);
  if (!verification) problems.push(`${file}: ${id} has no Verification: line`);
  if (!implementation || !verification) return;

  for (const path of backticked(implementation)) {
    if (!existsSync(join(root, path)))
      problems.push(`${file}: ${id} implementation path ${path} does not exist`);
    implementationPaths.add(path);
  }

  const tests = backticked(verification).filter((entry) => !new RegExp(`^${ID}$`).test(entry));
  if (tests.length === 0) problems.push(`${file}: ${id} Verification: names no test file`);
  let named = false;
  for (const path of tests) {
    const full = join(root, path);
    if (!existsSync(full)) {
      problems.push(`${file}: ${id} verification path ${path} does not exist`);
      continue;
    }
    if (!TEST_FILE.test(path)) {
      problems.push(`${file}: ${id} verification path ${path} is not a test file`);
      continue;
    }
    if (readFileSync(full, 'utf8').includes(id)) named = true;
  }
  if (tests.length > 0 && !named) {
    problems.push(`${file}: ${id} is not named by any test it lists in Verification:`);
  }
}

function checkSpec(name) {
  const file = `specs/${name}`;
  if (!/^[A-Z0-9]+(?:-[A-Z0-9]+)*\.md$/.test(name))
    problems.push(`${file}: spec file names are UPPER-KEBAB.md`);
  const lines = readFileSync(join(specsDir, name), 'utf8').split('\n');
  if (!lines[0]?.startsWith('# ')) problems.push(`${file}: first line must be a "# Title" heading`);

  /** @type {{ id: string, lines: string[] } | null} */
  let requirement = null;
  // The open group heading's number, the last group's number and the last number within it.
  let group = null;
  let lastGroup = 0;
  let lastNumber = 0;
  const checkNumbering = (level, id) => {
    const [, groupText = '', numberText] = id.match(NUMBERS) ?? [];
    const groupNumber = Number(groupText);
    if (level === '##') {
      if (numberText) problems.push(`${file}: group heading ${id} has a requirement number`);
      if (groupNumber <= lastGroup) {
        problems.push(`${file}: group ${id} comes after group ${lastGroup}; groups ascend`);
      }
      group = groupNumber;
      lastGroup = Math.max(lastGroup, groupNumber);
      lastNumber = 0;
      return;
    }
    const number = Number(numberText);
    if (groupNumber !== group) {
      problems.push(
        `${file}: ${id} is not under its group heading ## ${id.replace(/\.\d+[a-z]?$/, '')}`,
      );
    } else if (number !== lastNumber + 1) {
      problems.push(
        `${file}: ${id} follows ${lastNumber === 0 ? 'its group heading' : `.${lastNumber}`}; number requirements in order from 1 and keep withdrawn ones`,
      );
    }
    lastNumber = number;
  };
  const flush = () => {
    if (requirement) checkRequirement(file, requirement);
    requirement = null;
  };

  for (const line of lines) {
    if (line.startsWith('#')) {
      flush();
      const match = line.match(HEADING);
      if (match) {
        const [, level = '', id = ''] = match;
        if (ids.has(id)) problems.push(`${file}: ${id} is also defined in ${ids.get(id)}`);
        ids.set(id, file);
        const isSequence = /-T\d/.test(id);
        if (!isSequence) checkNumbering(level, id);
        if (level === '###' && !isSequence) requirement = { id, lines: [] };
      } else if (/^#{2,3} COLLAB-/.test(line)) {
        problems.push(
          `${file}: malformed requirement heading "${line}" (expected "### COLLAB-AREA-1.1 - Title")`,
        );
      } else if (line.startsWith('## ')) {
        group = null;
      }
      continue;
    }
    requirement?.lines.push(line.trim());
  }
  flush();
}

const specFiles = existsSync(specsDir)
  ? readdirSync(specsDir)
      .filter((name) => name.endsWith('.md') && name !== 'README.md')
      .sort()
  : [];
for (const name of specFiles) checkSpec(name);

// Every source module carries behaviour some requirement specifies; index.ts files only re-export.
const srcDir = join(root, 'src');
if (existsSync(srcDir)) {
  for (const full of walk(srcDir)) {
    const path = relativePosix(root, full);
    if (!path.endsWith('.ts') || TEST_FILE.test(path) || path.endsWith('/index.ts')) continue;
    if (!implementationPaths.has(path)) {
      problems.push(`${path} is not the Implementation: of any spec requirement`);
    }
  }
}

reportProblems(problems, {
  heading: 'Spec problems',
  success: `${specFiles.length} specs and ${ids.size} IDs are consistent.`,
});
