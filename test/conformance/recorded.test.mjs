// Payloads recorded from real sessions of the agents added in Phase 5, mapped
// through their adapters. Paths and the user name are masked in the fixtures
// (<CWD>, <HOME>, USER) and filled in with a temporary project here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as copilot from '../../src/adapters/copilot.mjs';
import { lastTranscriptText } from '../../src/adapters/common.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Loads a masked recording with <CWD> pointing at a temporary project. @param {string} file */
function load(file) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-recorded-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'cart.mjs'), 'export const x = 1;\n');
  const text = fs.readFileSync(path.join(FIXTURES, file), 'utf8').split('<CWD>').join(root.replace(/\\/g, '\\\\'));
  return { root, calls: text.trim().split('\n').map((l) => JSON.parse(l)) };
}

test('Copilot CLI 1.0.98: every recorded payload maps to the right event', () => {
  const { root, calls } = load('copilot/recorded-1.0.98.jsonl');
  const kinds = calls.map(({ event, payload }) => copilot.toEvent({ ...payload, hook_event_name: event }, root)?.kind ?? null);
  assert.deepEqual(kinds, [
    'turn_start', 'session_start', // Copilot sends the prompt before the session start.
    'tool_call', 'tool_result', 'tool_call', 'tool_call', 'tool_result', 'tool_result',
    'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result',
    'turn_end', 'session_end',
  ]);
});

test('Copilot CLI 1.0.98: exit codes, apply_patch files and read paths come out of the real payloads', () => {
  const { root, calls } = load('copilot/recorded-1.0.98.jsonl');
  const results = calls.filter((c) => /^postToolUse/.test(c.event)).map(({ event, payload }) => copilot.toEvent({ ...payload, hook_event_name: event }, root));
  const tests = results.filter((r) => r.isTest);
  assert.deepEqual(tests.map((r) => [r.exitCode, r.ok]), [[1, false], [0, true]], 'the first npm test failed with exit code 1, the last passed');
  assert.ok(tests[0].errorExcerpt, 'the failure has an excerpt for loop detection');
  const patch = results.find((r) => r.tool === 'Edit' && r.ok);
  assert.deepEqual(patch.files, ['src/cart.mjs'], 'the file is read from the apply_patch text');

  const view = calls.find((c) => c.event === 'preToolUse' && c.payload.toolName === 'view');
  const info = copilot.info({ ...view.payload, hook_event_name: 'preToolUse' });
  assert.match(String(info.toolInput.file_path), /src[\\/]cart\.mjs$/);
  const patchCall = calls.find((c) => c.event === 'preToolUse' && c.payload.toolName === 'apply_patch');
  assert.match(String(copilot.info({ ...patchCall.payload, hook_event_name: 'preToolUse' }).toolInput.file_path), /cart\.mjs$/);
});

test('Copilot CLI 1.0.98: the transcript gives the final reply and a token total that matches Copilot\'s own', () => {
  const file = path.join(FIXTURES, 'copilot', 'events-1.0.98.jsonl');
  assert.equal(lastTranscriptText(file, 'assistant'), 'Fixed `src/cart.mjs` to default missing quantities to 1; `npm test` now passes all 4 tests.');
  // Copilot's session.shutdown record for this run: input 21 + cache writes 6,941 + output 876.
  assert.equal(copilot.tokens(file)?.newTokens, 7838);
});

test('Copilot CLI: a sub-agent session (call_...) is guarded but never sized or gated', () => {
  const root = os.tmpdir();
  const start = copilot.toEvent({ hook_event_name: 'userPromptSubmitted', sessionId: 'call_abc123', prompt: 'Search the repo for total()' }, root);
  assert.equal(start.subagent, true);
  assert.equal(copilot.toEvent({ hook_event_name: 'agentStop', sessionId: 'call_abc123' }, root), null);
  assert.equal(copilot.toEvent({ hook_event_name: 'preToolUse', sessionId: 'call_abc123', toolName: 'powershell', toolArgs: { command: 'rm -rf ~' } }, root).kind, 'tool_call');
});

test('Antigravity agy 1.4.2: recorded payloads map to events, and outcomes come from the transcript', async () => {
  const antigravity = await import('../../src/adapters/antigravity.mjs');
  const transcript = path.join(FIXTURES, 'antigravity', 'transcript-1.4.2.jsonl');
  const { root, calls } = load('antigravity/recorded-1.4.2.jsonl');
  const kinds = calls.map(({ event, payload }) => antigravity.toEvent({ ...payload, hook_event_name: event }, root)?.kind ?? null);
  assert.deepEqual(kinds, [
    'session_start', 'turn_start', 'tool_call', 'tool_call', 'tool_result', 'tool_result', null,
    'turn_start', 'tool_call', 'tool_result', null, 'turn_start', 'tool_call', 'tool_result', null, 'turn_start', null, 'turn_end',
  ], 'PreInvocation fires before every model call; Keel starts a task only on the first');

  const list = antigravity.steps(transcript);
  assert.equal(antigravity.promptOf(list), 'Run npm test. Then fix src/cart.mjs so all tests pass, and run npm test again. Reply in one short sentence.');
  assert.match(String(antigravity.replyOf(list)), /^I updated \[`total`\]/);
  assert.equal(antigravity.tokens(transcript)?.newTokens, 21525, 'input plus output over every model call');
  // Step 2 ran in the background; its result arrived later as a system message.
  assert.deepEqual([antigravity.outcomeOf(list, 2)?.exitCode, antigravity.outcomeOf(list, 8)?.exitCode], [1, 0]);

  // At hook time the step is not in the transcript yet, so the result is pending, then amended.
  const first = calls.find((c) => c.event === 'PostToolUse');
  const pending = antigravity.toEvent({ ...first.payload, transcriptPath: path.join(FIXTURES, 'none.jsonl'), hook_event_name: 'PostToolUse' }, root);
  assert.equal(pending.pending, true);
  const [fix] = antigravity.amend({ transcriptPath: transcript }, [{ ...pending, session: 's' }]);
  assert.deepEqual([fix.kind, fix.amends, fix.exitCode, fix.ok], ['tool_result_amend', 'step-2', 1, false]);
});

test('the store puts an amended outcome back in its original place', async () => {
  const { mergeAmendments } = await import('../../src/store.mjs');
  const merged = mergeAmendments([
    { kind: 'tool_result', toolUseId: 'step-2', pending: true, ok: true, exitCode: null, isTest: true },
    { kind: 'tool_result', toolUseId: 'step-3', files: ['src/cart.mjs'] },
    { kind: 'tool_result_amend', amends: 'step-2', ok: false, exitCode: 1, v: 1, t: 'x', agent: 'antigravity', session: 's', turn: null },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual([merged[0].toolUseId, merged[0].pending, merged[0].ok, merged[0].exitCode], ['step-2', false, false, 1]);
  assert.equal(merged[1].toolUseId, 'step-3', 'the edit stays after the test run');
});
