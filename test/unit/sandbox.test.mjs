import '../isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxStatus, sandboxLine } from '../../src/sandbox.mjs';
import { renderReceipt } from '../../src/receipt.mjs';

/** A Claude Code config folder with a transcript in it, as Claude Code lays it out. */
function claudeWorld() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-sandbox-'));
  const config = path.join(base, 'claude');
  const transcript = path.join(config, 'projects', 'p', 's.jsonl');
  const root = path.join(base, 'repo');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(transcript, '');
  return { config, transcript, root };
}

test('Claude Code: the sandbox setting is read from the project first, then the user\'s settings', () => {
  const w = claudeWorld();
  assert.equal(sandboxStatus('claude-code', { transcriptPath: w.transcript, root: w.root }), 'off', 'off when nothing sets it');
  fs.writeFileSync(path.join(w.config, 'settings.json'), JSON.stringify({ sandbox: { enabled: true } }));
  assert.equal(sandboxStatus('claude-code', { transcriptPath: w.transcript, root: w.root }), 'on');
  fs.writeFileSync(path.join(w.root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: false } }));
  assert.equal(sandboxStatus('claude-code', { transcriptPath: w.transcript, root: w.root }), 'off', 'the project setting wins');
});

test('Codex: the sandbox comes from the session file, as a real 0.161.0 rollout records it', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'keel-sandbox-')), 'rollout.jsonl');
  fs.writeFileSync(file, '{"type":"turn_context","payload":{"sandbox_policy":{"type":"workspace-write","network_access":false}}}\n');
  assert.equal(sandboxStatus('codex', { transcriptPath: file }), 'workspace-write');
  assert.equal(sandboxStatus('copilot', { transcriptPath: file }), null);
});

test('the receipt says when the sandbox was off and how to turn it on', () => {
  const off = sandboxLine('claude-code', 'off');
  assert.match(String(off), /sandbox was off\. Keel reads each command before it runs, but it cannot see what a script does once it is running/);
  assert.match(String(off), /Run \/sandbox in Claude Code to turn it on\./);
  assert.match(String(sandboxLine('codex', 'danger-full-access')), /Codex ran with no sandbox/);
  const receipt = renderReceipt([{ kind: 'session_start', t: '2026-10-18T10:00:00Z' }], { storeDir: null, sandbox: off });
  assert.ok(receipt.includes(String(off)));
  assert.doesNotMatch(renderReceipt([{ kind: 'session_start', t: '2026-10-18T10:00:00Z' }], { storeDir: null }), /sandbox/);
});
