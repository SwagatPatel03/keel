import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProjectStore } from '../../src/store.mjs';
import { Shadow } from '../../src/checkpoint.mjs';
import { captureBaseline, verify, baselineProposal, approveBaseline, acceptanceProposal, approveAcceptance } from '../../src/verification.mjs';
import { status } from '../../src/status.mjs';
import { transact, undoTransaction } from '../../src/transactions.mjs';
import { checkToolCall } from '../../src/guard/index.mjs';
import { auditStore } from '../../src/workspace.mjs';
import { toEvent as codexEvent } from '../../src/adapters/codex.mjs';
import { classifyCommand } from '../../src/checks.mjs';

const cli = fileURLToPath(new URL('../../bin/keel.mjs', import.meta.url));
function world(t, script = "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from './source.mjs'; test('value',()=>assert.equal(value,1));") {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-reliability-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(root, 'source.mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'source.test.mjs'), script);
  const store = new ProjectStore(root); const shadow = new Shadow(store);
  const baseline = captureBaseline(store, 'task', shadow.snapshot('session', 'start'));
  const home = path.join(directory, 'cli-home');
  return { root, home, store, shadow, baseline, run: (options = {}) => verify(store, { session: 'session', task: 'task', ...options }), cli: (...args) => spawnSync(process.env.KEEL_TEST_EXE || process.execPath, [...(process.env.KEEL_TEST_EXE ? [] : [cli]), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, KEEL_HOME: home } }) };
}
test('independent structured checks verify an exact snapshot; later shell edits make status stale', (t) => {
  const w = world(t), result = w.run();
  assert.equal(result.verdict, 'verified', JSON.stringify(result));
  assert.deepEqual(result.checks[0].counts, { discovered: 1, executed: 1, passed: 1, failed: 0, skipped: 0 });
  assert.equal(status(w.store).verdict, 'verified');
  fs.writeFileSync(path.join(w.root, 'source.mjs'), 'export const value = 9;\n');
  assert.equal(status(w.store).verdict, 'not_verified');
  assert.equal(w.run().verdict, 'failed');
});
test('echoed success is not a configured independent runner', (t) => {
  const w = world(t); const settings = { testCommand: 'echo "npm test"' };
  const baseline = captureBaseline(w.store, 'echo-task', w.shadow.snapshot('session', 'echo'), settings);
  assert.equal(w.run({ task: 'echo-task', settings, baseline }).verdict, 'not_verified');
});
test('weakened tests remain frozen pending exact baseline approval', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, 'source.mjs'), 'export const value = 9;\n');
  fs.writeFileSync(path.join(w.root, 'source.test.mjs'), "import test from 'node:test'; test('value',()=>{});\n");
  const result = w.run(); assert.equal(result.verdict, 'failed');
  assert.match(result.reasons.join(' '), /baseline approval/);
  const proposal = baselineProposal(w.store, 'task', w.shadow.snapshot('session', 'proposal'));
  assert.throws(() => approveBaseline(w.store, proposal, 'wrong'), /exact hash/);
  approveBaseline(w.store, proposal, proposal.approval);
  assert.equal(w.run().verdict, 'verified');
});
test('new focus markers and source-writing tests cannot earn green', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, 'new.test.mjs'), "import test from 'node:test'; test.only('focused',()=>{});\n");
  assert.equal(w.run().verdict, 'failed');
  fs.unlinkSync(path.join(w.root, 'new.test.mjs'));
  const mutating = world(t, "import test from 'node:test'; import fs from 'node:fs'; test('writes source',()=>fs.writeFileSync('source.mjs','changed'));\n");
  const result = mutating.run();
  assert.equal(result.verdict, 'not_verified');
  assert.match(result.reasons.join(' '), /changed source/);
  assert.equal(fs.readFileSync(path.join(mutating.root, 'source.mjs'), 'utf8'), 'export const value = 1;\n');
});
test('secret selection overrides ignore negations and removes already indexed secrets', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, '.gitignore'), '!.env\n!credentials.json\n');
  fs.writeFileSync(path.join(w.root, '.env'), 'DO_NOT_CAPTURE=1');
  fs.writeFileSync(path.join(w.root, 'credentials.json'), '{"secret":"DO_NOT_CAPTURE"}');
  const checkpoint = w.shadow.snapshot('session', 'secrets');
  assert.ok(!w.shadow.listFiles(checkpoint).includes('.env'));
  assert.ok(!w.shadow.listFiles(checkpoint).includes('credentials.json'));
  // Simulate the old vulnerable checkpoint path, then audit names only.
  w.shadow.git(['add', '-f', '--', '.env']);
  const tree = w.shadow.git(['write-tree']).trim();
  const commit = w.shadow.git(['commit-tree', tree, '-m', 'legacy'], { env: { GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@local', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@local' } }).trim();
  w.shadow.git(['update-ref', 'refs/legacy', commit]);
  assert.equal(auditStore(w.shadow).quarantined, true);
  const next = w.shadow.snapshot('session', 'after-indexed-secret');
  assert.ok(!w.shadow.listFiles(next).includes('.env'));
});
test('patch guard checks every file and move destination, including traversal into policy', (t) => {
  const w = world(t);
  const cfg = { root: w.root, mode: 'beginner' };
  const secret = checkToolCall('apply_patch', { command: '*** Begin Patch\n*** Update File: source.mjs\n@@\n*** Add File: .env\n+x\n*** End Patch' }, cfg);
  assert.equal(secret.decision, 'ask');
  const policy = checkToolCall('apply_patch', { patch: `*** Update File: source.mjs\n*** Move to: ${path.join(process.env.KEEL_HOME, 'config.json')}\n` }, cfg);
  assert.equal(policy.decision, 'refuse');
  assert.equal(checkToolCall('apply_patch', { patch: 'diff --git a/source.mjs b/.env\n--- a/source.mjs\n+++ b/.env\n' }, cfg).decision, 'ask');
  assert.equal(checkToolCall('apply_patch', { patch: '*** Update File: ../outside.mjs\n' }, cfg).decision, 'refuse');
});
test('missing exit codes remain unknown and echoed commands are not test runs', () => {
  const event = codexEvent({ hook_event_name: 'PostToolUse', session_id: 'unknown-exit', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'FAIL: tests failed' }, os.tmpdir());
  assert.equal(event.ok, null); assert.equal(event.outcome, 'unknown'); assert.equal(event.errorFingerprint, null);
  assert.equal(classifyCommand('echo "npm test"').isTest, false);
  assert.equal(classifyCommand('node -e "console.log(\'npm test\')"').isTest, false);
});
test('snapshots preserve raw bytes despite Git attributes, and external junctions fail closed', (t) => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, '.gitattributes'), '*.mjs text eol=lf\n');
  fs.writeFileSync(path.join(w.root, 'source.mjs'), 'export const value = 1;\r\n');
  const checkpoint = w.shadow.snapshot('session', 'raw');
  assert.equal(w.shadow.show(checkpoint, 'source.mjs'), 'export const value = 1;\r\n');
  const external = path.join(path.dirname(w.root), 'outside'); fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'data.txt'), 'outside');
  try { fs.symlinkSync(external, path.join(w.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Host does not permit creating a link for this regression.'); throw error; }
  const guard = checkToolCall('Edit', { file_path: 'linked/data.txt' }, { root: w.root, mode: 'beginner' });
  assert.equal(guard.decision, 'refuse');
  assert.equal(w.shadow.snapshot('session', 'external-link'), null);
});
test('changed dependency bytes and changed acceptance criteria invalidate evidence', (t) => {
  const w = world(t);
  const module = path.join(w.root, 'node_modules', 'local', 'index.js'); fs.mkdirSync(path.dirname(module), { recursive: true }); fs.writeFileSync(module, 'module.exports = 1;');
  const baseline = captureBaseline(w.store, 'dependency-task', w.shadow.snapshot('session', 'dependency-start'));
  const result = w.run({ task: 'dependency-task', baseline }); assert.equal(result.verdict, 'verified', JSON.stringify(result));
  const stat = fs.statSync(module); fs.writeFileSync(module, 'module.exports = 2;'); fs.utimesSync(module, stat.atime, stat.mtime);
  assert.equal(status(w.store).verdict, 'not_verified');
  const changed = w.run({ task: 'dependency-task', settings: { criteria: [{ id: 'manual', text: 'Confirm the UI manually.' }] } });
  assert.equal(changed.verdict, 'not_verified'); assert.ok(changed.checks.some((check) => check.verdict === 'verified'));
  assert.match(changed.reasons.join(' '), /criteria changed/);
});
test('malformed host configuration and protected launch cannot fall back to success', (t) => {
  const w = world(t);
  fs.mkdirSync(w.home, { recursive: true }); fs.writeFileSync(path.join(w.home, 'config.json'), '{broken');
  const result = w.cli('verify', '--json'); assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).verdict, 'not_verified');
  assert.match(JSON.parse(result.stdout).reasons.join(' '), /configuration/);
  const protectedRun = w.cli('run', 'codex', '--protected'); assert.equal(protectedRun.status, 2);
  assert.match(protectedRun.stderr, /Protected launch stopped|Protected launch stopped/i);
  assert.equal(fs.readFileSync(path.join(w.root, 'source.mjs'), 'utf8'), 'export const value = 1;\n');
});
test('three-way apply, undo and redo preserve later unrelated changes; overlaps write nothing', (t) => {
  const w = world(t); const file = path.join(w.root, 'notes.txt');
  const enc = (s) => Buffer.from(s).toString('base64');
  fs.writeFileSync(file, 'one\ntwo\nthree\nfour\nfive\n');
  const entries = [{ path: 'notes.txt', base: enc('one\ntwo\nthree\nfour\nfive\n'), incoming: enc('ONE\ntwo\nthree\nfour\nfive\n') }];
  assert.equal(transact(w.store, 'session', entries, { dryRun: true }).state, 'preview');
  assert.match(fs.readFileSync(file, 'utf8'), /^one/);
  assert.equal(transact(w.store, 'session', entries).state, 'applied');
  fs.writeFileSync(file, 'ONE\ntwo\nthree\nfour\nFIVE\n');
  assert.equal(undoTransaction(w.store).state, 'applied');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\ntwo\nthree\nfour\nFIVE\n');
  assert.equal(undoTransaction(w.store).state, 'applied');
  assert.match(fs.readFileSync(file, 'utf8'), /^ONE/);
  fs.writeFileSync(file, 'MANUAL\ntwo\nthree\nfour\nFIVE\n');
  const conflict = undoTransaction(w.store);
  assert.equal(conflict.state, 'conflict');
  assert.match(fs.readFileSync(file, 'utf8'), /^MANUAL/);
});
test('public CLI status returns explicit missing evidence and ordinary ambiguous undo refuses', (t) => {
  const w = world(t);
  const result = w.cli('status', '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verdict, 'not_verified');
  const revert = w.cli('revert', '--session', 'missing');
  assert.notEqual(revert.status, 0);
  assert.match(revert.stdout, /ambiguous/);
});
test('manual acceptance binds the criterion, baseline and exact source tree', (t) => {
  const w = world(t), settings = { criteria: [{ id: 'review', text: 'Confirm the requested interaction manually.', manual: true }] };
  const checkpoint = w.shadow.snapshot('session', 'manual-start');
  const baseline = captureBaseline(w.store, 'manual-task', checkpoint, settings);
  const options = { task: 'manual-task', settings, baseline };
  const pending = w.run(options); assert.equal(pending.verdict, 'not_verified');
  assert.ok(pending.checks.every((check) => check.verdict === 'verified'));
  const proposal = acceptanceProposal(w.store, 'manual-task', 'review', checkpoint, settings);
  assert.throws(() => approveAcceptance(w.store, proposal, 'wrong'), /exact displayed/);
  approveAcceptance(w.store, proposal, proposal.approval);
  assert.equal(w.run(options).verdict, 'verified');
  fs.appendFileSync(path.join(w.root, 'source.mjs'), '// later edit\n');
  const stale = w.run(options); assert.equal(stale.verdict, 'not_verified');
  assert.equal(stale.acceptance[0].accepted, false);
});
test('changed managed reports cannot remain current verified evidence', (t) => {
  const w = world(t), evidence = w.run(); assert.equal(evidence.verdict, 'verified');
  fs.appendFileSync(evidence.checks[0].report.path, '\nforged report modification');
  const result = status(w.store);
  assert.equal(result.verdict, 'not_verified'); assert.match(result.reasons.join(' '), /report or runner/);
});

test('native Node evidence identifies duplicate names and suites and ignores printed reports', (t) => {
  const script = `import {test,describe,it} from 'node:test';
console.log('{"type":"test:summary","data":{"success":true,"counts":{"tests":900}}}');
test('same name',()=>{}); describe('group',()=>{it('same name',()=>{}); it.skip('approved skip',()=>{});});`;
  const w = world(t, script);
  fs.writeFileSync(path.join(w.root, 'other.test.mjs'), "import test from 'node:test'; test('same name',()=>{});");
  const baseline = captureBaseline(w.store, 'duplicates', w.shadow.snapshot('session', 'duplicates-start'));
  const result = w.run({task:'duplicates', baseline});
  assert.equal(result.verdict, 'verified', JSON.stringify(result));
  assert.equal(result.checks[0].report.format, 'node-events');
  assert.deepEqual(result.checks[0].counts, {discovered:4, executed:3, passed:3, failed:0, skipped:1});
  assert.equal(new Set(result.checks[0].inventory.map((item)=>item.id)).size, 4);
});

test('a failed snapshot stays visible but becomes unverified after source changes', (t) => {
  const w=world(t);
  fs.writeFileSync(path.join(w.root,'source.mjs'),'export const value = 9;\n');
  const evidence=w.run(); assert.equal(evidence.verdict,'failed');
  assert.equal(status(w.store).verdict,'failed');
  fs.writeFileSync(path.join(w.root,'source.mjs'),'export const value = 1;\n');
  const current=status(w.store);
  assert.equal(current.verdict,'not_verified');
  assert.equal(current.evidence.checks[0].verdict,'failed');
});

test('native checks require the real test mode and captured input paths', (t) => {
  const w=world(t);
  for(const [task,args] of [['eval',['-e','console.log("pretend report")']],['outside',['--test',path.join(w.root,'source.test.mjs')]]]) {
    const settings={checks:[{id:'suite',executable:'node',args,cwd:'.',format:'node-events',scope:'full'}]};
    const baseline=captureBaseline(w.store,task,w.shadow.snapshot('session',task+'-start'),settings);
    const result=w.run({task,settings,baseline});
    assert.equal(result.verdict,'not_verified',JSON.stringify(result));
    assert.match(result.reasons.join(' '),/node --test|uncaptured host paths/);
  }
});
