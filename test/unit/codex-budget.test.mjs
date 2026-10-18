import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codex from '../../src/adapters/codex.mjs';
import { cumulativeNewTokens, cumulativeUsage, budgetStatus, budgetWarning, meterLine, weightsFor, WEIGHTS } from '../../src/budget.mjs';
import { loadConfig } from '../../src/store.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Loads the recorded Codex run with its placeholders pointed at a temp project and rollout. */
function loadCodexRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-codex-'));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'math.mjs'), 'export function add(a,b){return a+b}\n');
  const rollout = path.join(dir, 'rollout.jsonl');
  const once = JSON.stringify(root).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  const fill = (s) => s.split('<CWD2>').join(twice).split('<CWD>').join(once).split('<CWD_FWD>').join(root.split(path.sep).join('/')).split('<ROLLOUT>').join(JSON.stringify(rollout).slice(1, -1));
  fs.writeFileSync(rollout, fill(fs.readFileSync(path.join(fixtures, 'codex', 'rollout-0.161.0.jsonl'), 'utf8')));
  const payloads = fill(fs.readFileSync(path.join(fixtures, 'codex', 'recorded-0.161.0.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  return { root, rollout, payloads };
}

test('maps every recorded Codex 0.161.0 payload to a canonical event', () => {
  const { root, payloads } = loadCodexRun();
  const events = payloads.map((p) => codex.toEvent(p, root));
  assert.deepEqual(events.map((e) => e.kind), ['session_start', 'turn_start', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'turn_end']);
  assert.ok(events.every((e) => e.agent === 'codex' && e.session === '01a14c6e-b4c8-7251-a635-b24ba76d571d'));
  assert.equal(events[1].turn, '01a14c6e-b5c7-72d3-9d13-0a3da682d968');
});

test('reads exit codes for Codex commands from the rollout file', () => {
  const { root, payloads } = loadCodexRun();
  const results = payloads.filter((p) => p.hook_event_name === 'PostToolUse').map((p) => codex.toEvent(p, root));
  const [firstRun, , patch, secondRun] = results;
  assert.equal(firstRun.command, 'node check.mjs');
  assert.equal(firstRun.exitCode, 1);
  assert.equal(firstRun.ok, false);
  assert.equal(firstRun.errorExcerpt, 'FAIL add(2,2)=0');
  assert.ok(firstRun.errorFingerprint);
  assert.equal(firstRun.isTest, false, '"node check.mjs" is not a recognised test command');
  assert.equal(secondRun.exitCode, 0);
  assert.equal(secondRun.ok, true);
  assert.equal(patch.tool, 'apply_patch');
  assert.deepEqual(patch.files, ['math.mjs']);
  assert.equal(patch.ok, true);
  assert.ok(patch.fileHash);
});

test('finds files in apply_patch bodies', () => {
  assert.deepEqual(codex.patchFiles('*** Begin Patch\n*** Add File: src/a.js\n+x\n*** Update File: src/b.js\n*** Move to: src/c.js\n*** Delete File: old.js\n*** End Patch'), ['src/a.js', 'src/b.js', 'src/c.js', 'old.js']);
});

test('renders decisions as Codex hook output', () => {
  assert.deepEqual(codex.render({ type: 'ask', reason: 'r' }, 'PreToolUse'), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'r' } });
  assert.deepEqual(codex.render({ type: 'halt', message: 'm', agentNote: 'n' }, 'PostToolUse'), { decision: 'block', reason: 'n', systemMessage: 'm' });
  assert.deepEqual(codex.render({ type: 'context', text: 't' }, 'UserPromptSubmit'), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 't' } });
  assert.deepEqual(codex.render({ type: null, notice: 'w' }, 'PreToolUse'), { systemMessage: 'w' });
  assert.equal(codex.render(null, 'PreToolUse'), null);
});

test('new tokens: Codex total matches what Codex itself reported (5,844)', () => {
  const { rollout } = loadCodexRun();
  assert.equal(cumulativeNewTokens('codex', rollout), 5844);
});

test('new tokens: Claude Code counts each message once, without cache re-reads', () => {
  // From the recorded 2.1.291 transcript: input + output + cache writes for its 4 messages.
  assert.equal(cumulativeNewTokens('claude-code', path.join(fixtures, 'claude-code', 'transcript-2.1.291.jsonl')), 48751 + 637 + 869 + 617);
  assert.equal(cumulativeNewTokens('claude-code', 'missing.jsonl'), null);
});

test('new-token budgets (older configs): levels are crossed once each, and several at once are all recorded', () => {
  const start = { kind: 'turn_start', turn: 't1', size: 'small', usageBase: 1000 };
  const budgets = { small: 10000 };
  assert.equal(budgetStatus([start], 7000, budgets, 'new-tokens').level, null, '60% is below the first level');
  const s70 = budgetStatus([start], 8100, budgets, 'new-tokens');
  assert.equal(s70.level, 0.7);
  assert.deepEqual(s70.crossed, [0.7]);
  const after70 = [start, { kind: 'budget', turn: 't1', level: 0.7 }];
  assert.equal(budgetStatus(after70, 8500, budgets, 'new-tokens').level, null, 'no repeat at the same level');
  const jump = budgetStatus(after70, 12000, budgets, 'new-tokens');
  assert.deepEqual(jump.crossed, [0.9, 1]);
  assert.equal(jump.level, 1);
  assert.equal(budgetWarning(jump), 'Keel: this small task has used about 11,000 of its 10,000 new-token budget (110%). Claude will carry on; you can stop it at any time.');
  assert.equal(meterLine(s70), 'Keel: small task, about 7,100 of 10,000 new tokens (71%)');
  assert.equal(meterLine(null), 'Keel: no task yet');
});

test('continuations count towards the task that started them', () => {
  const events = [
    { kind: 'turn_start', turn: 't1', size: 'feature', usageBase: 0 },
    { kind: 'turn_start', turn: 't2', continuation: true, size: 'feature' },
  ];
  const s = budgetStatus(events, 120000, { feature: 150000 }, 'new-tokens');
  assert.equal(s.turn, 't1');
  assert.equal(s.level, 0.7);
});

test('budget units weigh each kind of token by price, and keep new tokens alongside', () => {
  // Codex 0.161.0 run: 117,501 input of which 112,384 cached, 727 output, no cache writes.
  const c = cumulativeUsage('codex', loadCodexRun().rollout);
  assert.equal(c?.newTokens, 5844);
  assert.equal(Math.round((c?.units ?? 0) * 10) / 10, 5117 + 11238.4 + 727 * 6);
  const claude = cumulativeUsage('claude-code', path.join(fixtures, 'claude-code', 'transcript-2.1.291.jsonl'));
  assert.equal(claude?.newTokens, 50874);
  assert.equal(Math.round(claude?.units ?? 0), 81929);
  assert.equal(weightsFor('gpt-5.6-luna'), WEIGHTS.openai);
  assert.equal(weightsFor('claude-opus-5-5'), WEIGHTS.anthropic);
  assert.equal(weightsFor(null, 'codex'), WEIGHTS.openai);
  assert.equal(weightsFor('gemini-3-pro'), WEIGHTS.anthropic, 'no published rate: the default weights');
});

test('weighted budgets: warnings name the units and the raw tokens; older numeric records never warn by mistake', () => {
  const start = { kind: 'turn_start', turn: 't1', size: 'small', usageBase: { units: 1000, newTokens: 500, output: 10 } };
  const budgets = { small: 90000 };
  const s70 = budgetStatus([start], { units: 64000, newTokens: 21500, output: 3010 }, budgets);
  assert.deepEqual([s70?.level, s70?.used, s70?.newTokens, s70?.output], [0.7, 63000, 21000, 3000]);
  assert.equal(budgetWarning(/** @type {any} */ (s70)), 'Keel: this small task has used about 70% of its budget (63,000 of 90,000 units; 21,000 new tokens, 3,000 of them output).');
  assert.equal(meterLine(/** @type {any} */ (s70)), 'Keel: small task, 70% of budget (63,000 of 90,000 units, 21,000 new tokens)');
  const over = budgetStatus([start], { units: 95000, newTokens: 30000, output: 5000 }, budgets);
  assert.match(budgetWarning(/** @type {any} */ (over), { stops: true }), /Keel is stopping the agent, as your budget setting asks\.$/);
  const legacy = { ...start, usageBase: 500 };
  assert.equal(budgetStatus([legacy], { units: 999999, newTokens: 999999, output: 0 }, budgets), null, 'a base stored as a plain number has no units');
});

test('settings: no budgets means weighted units; budgets without budgetUnits stay in new tokens', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-units-'));
  process.env.KEEL_HOME = home;
  try {
    assert.equal(loadConfig().budgetUnits, 'weighted');
    assert.equal(loadConfig().budgets.small, 90000);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ budgets: { small: 30000 } }));
    assert.deepEqual([loadConfig().budgetUnits, loadConfig().budgets.small, loadConfig().budgets.feature], ['new-tokens', 30000, 150000]);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ budgets: { small: 120000 }, budgetUnits: 'weighted', budget: { onLimit: 'stop' } }));
    assert.deepEqual([loadConfig().budgetUnits, loadConfig().budgets.small, loadConfig().budget.onLimit], ['weighted', 120000, 'stop']);
  } finally {
    delete process.env.KEEL_HOME;
  }
});

test('Codex: an exit_code field in tool_response is used first; plain text still uses the rollout', () => {
  const root = os.tmpdir();
  const base = { hook_event_name: 'PostToolUse', session_id: 's', cwd: root, tool_name: 'shell', tool_input: { command: 'npm test' }, tool_use_id: 'c1', transcript_path: path.join(root, 'no-rollout.jsonl') };
  const failed = codex.toEvent({ ...base, tool_response: { exit_code: 1, output: 'not ok 1 - total\n' } }, root);
  assert.deepEqual([failed.exitCode, failed.ok, failed.isTest], [1, false, true]);
  assert.match(String(failed.errorExcerpt), /not ok 1 - total/);
  const passed = codex.toEvent({ ...base, tool_response: { exitCode: 0, stdout: 'ok' } }, root);
  assert.deepEqual([passed.exitCode, passed.ok], [0, true]);
  const text = codex.toEvent({ ...base, tool_response: 'ok\n' }, root);
  assert.equal(text.exitCode, null, 'no field and no rollout: unknown, as before');
});
