import '../isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../../src/store.mjs';
import { Shadow } from '../../src/checkpoint.mjs';
import { processHook } from '../../src/shim.mjs';
import * as claudeCode from '../../src/adapters/claude-code.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function project() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-prune-repo-'));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  const store = new ProjectStore(repo);
  return { repo, store, shadow: new Shadow(store) };
}

/** Session ids that still have checkpoints. @param {Shadow} shadow */
const sessionsLeft = (shadow) => [...new Set(shadow.git(['for-each-ref', '--format=%(refname)', 'refs/keel/sessions']).split('\n').filter(Boolean).map((r) => r.split('/')[3]))].sort();

test('old sessions are pruned; the current session and the latest green checkpoint stay', () => {
  const { repo, shadow } = project();
  const green = shadow.snapshot('old-green', 'turn-1-start');
  shadow.markGreen('old-green', String(green));
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  shadow.snapshot('old-other', 'turn-1-start');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
  shadow.snapshot('current', 'turn-1-start');

  assert.equal(shadow.prune({ keep: 'current' }).removed, 0, 'nothing is older than 30 days yet');
  const r = shadow.prune({ now: Date.now() + 40 * 86400000, keep: 'current' });
  assert.equal(r.removed, 2);
  assert.deepEqual(sessionsLeft(shadow), ['current']);
  assert.equal(shadow.resolve('refs/keel/green'), green, 'the latest green checkpoint survives');
  assert.equal(shadow.show(String(green), 'a.txt'), 'one\n', 'and its files are still there after git gc');
});

test('over the size limit, the oldest sessions go first, never the current one', () => {
  const { repo, shadow } = project();
  for (const id of ['s1', 's2', 's3', 's4']) {
    fs.writeFileSync(path.join(repo, 'a.txt'), `${id}\n`);
    shadow.snapshot(id, 'turn-1-start');
  }
  const r = shadow.prune({ maxBytes: 1, keep: 's4' });
  assert.ok(r.removed >= 2);
  assert.deepEqual(sessionsLeft(shadow), ['s4']);
});

test('keel prune from the terminal, and the once-a-day background start from the session-start hook', () => {
  const { repo, store, shadow } = project();
  shadow.snapshot('s1', 'turn-1-start');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'keel.mjs'), 'prune', repo], { encoding: 'utf8', env: { ...process.env } });
  assert.match(cli.stdout, /^Keel removed the checkpoints of 0 old sessions\. The store went from [\d.]+ MB to [\d.]+ MB\./);

  const marker = path.join(store.dir, 'pruned-at');
  const before = process.env.KEEL_NO_BACKGROUND;
  delete process.env.KEEL_NO_BACKGROUND;
  try {
    processHook(claudeCode, { hook_event_name: 'SessionStart', session_id: 'bg1', cwd: repo, source: 'startup' }, { pluginRoot: ROOT });
    assert.ok(fs.existsSync(marker), 'a background prune was started and recorded');
    const first = fs.readFileSync(marker, 'utf8');
    processHook(claudeCode, { hook_event_name: 'SessionStart', session_id: 'bg2', cwd: repo, source: 'startup' }, { pluginRoot: ROOT });
    assert.equal(fs.readFileSync(marker, 'utf8'), first, 'not again on the same day');
  } finally {
    if (before !== undefined) process.env.KEEL_NO_BACKGROUND = before;
  }
});
