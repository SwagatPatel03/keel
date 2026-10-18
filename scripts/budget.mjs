#!/usr/bin/env node
// Always-on token budget check. Fails when Keel would add more than BUDGET
// tokens to every session before any work starts.
//
// Uses Claude Code's own projection (`claude plugin details`) when the CLI is
// installed. Otherwise (for example in CI) it estimates from the text Claude
// Code lists at session start: each skill's name and description. Hooks run
// outside the model and cost nothing unless they print, and Keel's hooks
// print nothing on normal turns (the replay tests check that).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BUDGET = 1000;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function fromClaude() {
  const res = spawnSync('claude', ['--plugin-dir', root, 'plugin', 'details', 'keel'], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const m = /Always-on:\s*~?([\d,]+)\s*tok/.exec(res.stdout || '');
  return m ? { tokens: Number(m[1].replace(/,/g, '')), source: 'claude plugin details' } : null;
}

function estimate() {
  const skillsDir = path.join(root, 'skills');
  let chars = 0;
  for (const name of fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : []) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(file, 'utf8').replace(/\r/g, ''))?.[1] || '';
    const field = (k) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(front)?.[1] || '';
    chars += `/${name} ${field('description')} ${field('when_to_use')} ${field('argument-hint')}`.length;
  }
  // About 3.5 characters per token for English; round up to stay conservative.
  return { tokens: Math.ceil(chars / 3.5) + 10, source: 'estimate from skill listings' };
}

const result = fromClaude() || estimate();
const line = `Keel always-on cost: ~${result.tokens} tokens (${result.source}); budget ${BUDGET}.`;
if (result.tokens > BUDGET) {
  console.error(`${line} Over budget.`);
  process.exit(1);
}
console.log(line);
