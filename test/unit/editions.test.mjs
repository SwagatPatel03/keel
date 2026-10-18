// The Node.js edition and the compiled platform editions.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processHook } from '../../src/shim.mjs';
import * as claudeCode from '../../src/adapters/claude-code.mjs';
import { isCompiled, terminalCommand } from '../../src/runtime.mjs';
import { binarySkill, TARGETS } from '../../scripts/build-binaries.mjs';
import { zip } from '../../scripts/zip.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('two Keel plugins in one session: the second to start tells the user once', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-editions-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-editions-repo-'));
  process.env.KEEL_HOME = home;
  try {
    const payload = { session_id: 's1', cwd: repo, hook_event_name: 'SessionStart', source: 'startup' };
    const first = processHook(claudeCode, { ...payload }, { pluginRoot: ROOT, edition: 'node' });
    assert.doesNotMatch(JSON.stringify(first ?? {}), /two Keel plugins/);
    const second = processHook(claudeCode, { ...payload }, { pluginRoot: ROOT, edition: 'compiled' });
    assert.match(String(second?.systemMessage), /two Keel plugins are installed/);
    const again = processHook(claudeCode, { ...payload, session_id: 's2' }, { pluginRoot: ROOT, edition: 'node' });
    assert.doesNotMatch(JSON.stringify(again ?? {}), /two Keel plugins/, 'one edition alone says nothing');
  } finally {
    delete process.env.KEEL_HOME;
  }
});

test('compiled skills run the executable, and their permission rule matches the quoted command', () => {
  for (const name of ['receipt', 'revert', 'learn']) {
    const text = binarySkill(fs.readFileSync(path.join(ROOT, 'skills', name, 'SKILL.md'), 'utf8'), 'keel.exe');
    assert.doesNotMatch(text, /\bnode\b/);
    const rule = /^allowed-tools: Bash\((.*)\)$/m.exec(text)?.[1] || '';
    const command = /!`(.*)`/.exec(text)?.[1].replace('${CLAUDE_PLUGIN_ROOT}', 'C:/Users/A B/.claude/plugins/cache/keel/bin'.replace('/bin', '')) || '';
    const re = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    assert.match(command, re, `${name}: ${rule} must match ${command}`);
  }
});

test('the Node.js edition is not mistaken for a compiled one, and names node in terminal commands', () => {
  assert.equal(isCompiled(import.meta.url), false);
  assert.equal(isCompiled('file:///B:/%7EBUN/root/keel.exe'), typeof (/** @type {any} */ (globalThis).Bun) !== 'undefined');
  assert.match(terminalCommand(ROOT), /^node ".*keel\.mjs"$/);
});

test('every platform build has a label and an executable name', () => {
  for (const [name, t] of Object.entries(TARGETS)) {
    assert.match(t.label, /\w/);
    assert.equal(t.exe, name.startsWith('windows') ? 'keel.exe' : 'keel');
  }
});

test('the zip writer makes archives that unpack with the executable bit set', () => {
  const archive = zip([{ name: 'bin/keel', data: Buffer.from('#!/bin/sh\n'), mode: 0o755 }, { name: 'README.md', data: Buffer.from('hi') }]);
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  /** Unix permissions per entry, read from the central directory. */
  const modes = {};
  let at = archive.readUInt32LE(archive.length - 22 + 16);
  for (let i = 0; i < 2; i++) {
    const len = archive.readUInt16LE(at + 28);
    modes[archive.subarray(at + 46, at + 46 + len).toString()] = (archive.readUInt32LE(at + 38) >>> 16) & 0o777;
    at += 46 + len;
  }
  assert.deepEqual(modes, { 'bin/keel': 0o755, 'README.md': 0o644 });
  assert.equal(zip([{ name: 'a', data: Buffer.from('x') }]).equals(zip([{ name: 'a', data: Buffer.from('x') }])), true, 'the same files give the same zip');
});
