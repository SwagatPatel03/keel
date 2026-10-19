import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, blockReason } from '../../src/gate.mjs';
import { extractClaims } from '../../src/claims.mjs';
import { findTestTampering } from '../../src/testdiff.mjs';

const editEv = (file) => ({ kind: 'tool_result', ok: true, files: [file] });
const testEv = (ok, command = 'npm test') => ({ kind: 'tool_result', ok, isTest: true, command, exitCode: ok ? 0 : 1, errorExcerpt: ok ? null : '1 failing', files: [] });
const changed = [{ status: 'M', path: 'src/cart.mjs' }];

function run(message, opts = {}) {
  const calls = [];
  const result = evaluate({
    claims: extractClaims(message),
    turnEvents: opts.events ?? [],
    turnChanges: opts.turnChanges ?? [],
    sessionChanges: opts.sessionChanges ?? opts.turnChanges ?? [],
    tampering: opts.tampering ?? [],
    testCommand: 'testCommand' in opts ? opts.testCommand : 'npm test',
    buildCommand: opts.buildCommand ?? null,
    runChecks: opts.runChecks ?? true,
    run: (cmd) => { calls.push(cmd); return { command: cmd, ok: opts.checkPasses ?? true, exitCode: opts.checkPasses === false ? 1 : 0, timedOut: !!opts.timedOut, durationMs: 5, excerpt: '2 failing' }; },
  });
  return { ...result, calls };
}

test('an agent-reported passing run alone cannot authorize a green checkpoint', () => {
  const r = run('I fixed the total in `src/cart.mjs` and all tests pass.', { events: [editEv('src/cart.mjs'), testEv(true)], turnChanges: changed });
  assert.equal(r.findings.at(-1).kind, 'verification-unavailable');
  assert.deepEqual(r.calls, []);
  assert.equal(r.green, false);
});

test('a tests claim with no run makes Keel run the tests, and a failure blocks', () => {
  const r = run('All tests pass.', { events: [editEv('src/cart.mjs')], turnChanges: changed, checkPasses: false });
  assert.deepEqual(r.calls, ['npm test']);
  assert.equal(r.findings[0].kind, 'tests-claim-failed');
  assert.match(r.findings[0].message, /Keel ran `npm test` and it failed/);
  assert.equal(r.green, false);
});

test('legacy shell execution is diagnostic and cannot authorize green', () => {
  const r = run('All tests pass.', { events: [editEv('src/cart.mjs')], turnChanges: changed, checkPasses: true });
  assert.equal(r.findings.at(-1).kind, 'verification-unavailable');
  assert.equal(r.green, false);
});

test('a tests claim contradicted by the agent\'s own last run blocks without rerunning', () => {
  const r = run('All tests pass.', { events: [editEv('src/cart.mjs'), testEv(false)], turnChanges: changed });
  assert.deepEqual(r.calls, []);
  assert.equal(r.findings[0].kind, 'tests-claim-failed');
});

test('with checks turned off, an unrun tests claim asks the agent to run them', () => {
  const r = run('All tests pass.', { events: [editEv('src/cart.mjs')], turnChanges: changed, runChecks: false });
  assert.equal(r.findings[0].kind, 'tests-claim-unrun');
});

test('a timed-out check asks for an honest unverified result once', () => {
  const r = run('All tests pass.', { events: [editEv('src/cart.mjs')], turnChanges: changed, checkPasses: false, timedOut: true });
  assert.equal(r.findings.at(-1).kind, 'verification-unavailable');
});

test('a claim about earlier work in a turn with no changes does not run anything', () => {
  const r = run('All tests pass.', { events: [], turnChanges: [] });
  assert.deepEqual(r.calls, []);
  assert.equal(r.findings.at(-1).kind, 'verification-unavailable');
});

test('a done claim with failing tests blocks', () => {
  const r = run('Done! The discount bug is fixed.', { events: [editEv('src/cart.mjs')], turnChanges: changed, checkPasses: false });
  assert.equal(r.findings[0].kind, 'done-claim-failing-tests');
});

test('a done claim without a configured check stays unverified', () => {
  const r = run('Done! The discount bug is fixed.', { events: [editEv('src/cart.mjs')], turnChanges: changed, testCommand: null });
  assert.equal(r.findings.at(-1).kind, 'verification-unavailable');
  assert.deepEqual(r.calls, []);
});

test('a claimed file change that did not happen blocks', () => {
  const r = run('I updated `src/discount.mjs` to round correctly.', { turnChanges: changed });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, 'file-claim-unchanged');
  assert.match(blockReason(r.findings), /src\/discount\.mjs/);
});

test('a claimed file changed earlier in the session is accepted', () => {
  const r = run('I updated `src/discount.mjs` earlier.', { turnChanges: [], sessionChanges: [{ status: 'M', path: 'src/discount.mjs' }] });
  assert.deepEqual(r.findings, []);
});

test('"I fixed it" with no file changes anywhere in the session blocks', () => {
  const r = run('I fixed the rounding bug.', { turnChanges: [], sessionChanges: [] });
  assert.equal(r.findings[0].kind, 'done-claim-no-changes');
});

test('weakened tests are reported even without any claim', () => {
  const before = "test('a', () => {});\ntest('b', () => {});\n";
  const after = "test('a', () => {});\ntest.skip('b', () => {});\n";
  const tampering = findTestTampering(
    [{ status: 'D', path: 'test/discount.test.mjs' }, { status: 'M', path: 'test/cart.test.mjs' }],
    (file, side) => (file === 'test/discount.test.mjs' ? (side === 'before' ? before : null) : side === 'before' ? before : after),
  );
  assert.deepEqual(tampering.map((t) => t.kind), ['deleted-test-file', 'added-skip']);
  const r = run('Here is a summary of the session.', { tampering });
  assert.deepEqual(r.findings.map((f) => f.kind), ['deleted-test-file', 'added-skip']);
  assert.match(r.findings[0].message, /deleted the test file `test\/discount\.test\.mjs` \(2 tests\)/);
});

test('removing test cases is reported', () => {
  const t = findTestTampering([{ status: 'M', path: 'tests/test_cart.py' }], (_f, side) =>
    side === 'before' ? 'def test_a():\n    pass\n\ndef test_b():\n    pass\n' : 'def test_a():\n    pass\n');
  assert.deepEqual(t, [{ kind: 'removed-test-cases', file: 'tests/test_cart.py', before: 2, after: 1 }]);
});
