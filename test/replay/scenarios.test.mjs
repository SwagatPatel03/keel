// Phase 1 exit criteria, replayed through the real hook shim:
//   - a seeded false "done" is caught (three kinds, plus weakened tests),
//   - a seeded 3x loop is stopped (same error, and edits back and forth),
//   - clear, passing turns produce no output at all (zero added tokens).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWorld, BUGGY_CART, FIXED_CART, KEEL_EXEC, KEEL_PRE } from './harness.mjs';

test('a clear, passing turn adds nothing: every hook prints nothing', () => {
  const s = makeWorld().session();
  const outputs = [
    s.start(),
    s.prompt('Make total() handle quantities.'),
    s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small')),
    s.bash('npm test', { stdout: '# pass 3' }),
    s.stop('I updated `src/cart.mjs` and all tests pass.'),
    s.end(),
  ];
  for (const o of outputs) {
    assert.equal(o.status, 0);
    assert.equal(o.out, '', `expected no output, got: ${o.out} ${o.stderr}`);
  }
});

test('seeded false done 1: a claimed file change that did not happen is blocked once', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Fix the rounding in applyDiscount.');
  const r = s.stop('I updated `src/discount.mjs` so applyDiscount rounds correctly.');
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /You said you changed `src\/discount\.mjs`, but that file has no changes/);
  // Claude continues, still does nothing, and stops again: Keel never blocks twice in a turn.
  const again = s.stop('I updated `src/discount.mjs` so applyDiscount rounds correctly.', { active: true });
  assert.equal(again.out, '');
});

test('seeded false done 2: "all tests pass" with no test run, while tests fail, is blocked with Keel\'s own run', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Tidy up the cart code.');
  s.edit('src/cart.mjs', BUGGY_CART);
  const r = s.stop('I cleaned up `src/cart.mjs`. All tests pass.');
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /Report the task as failed/);
});

test('"all tests pass" with no test run, while tests really pass, is accepted and makes a green checkpoint', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.prompt('Tidy up the cart code.');
  s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small'));
  assert.equal(s.stop('I cleaned up `src/cart.mjs`. All tests pass.').out, '');
  assert.match(s.cli('receipt'), /The last green checkpoint was saved at/);
});

test('seeded false done 3: deleting a failing test and claiming success is blocked', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Make the tests pass.');
  s.edit('src/cart.mjs', BUGGY_CART);
  fs.rmSync(path.join(s.repo, 'test', 'cart.test.mjs'));
  s.bash('rm test/cart.test.mjs');
  const r = s.stop('Done. Everything works now.');
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /You deleted the test file `test\/cart\.test\.mjs` \(3 tests\)/);
});

test('skipping a failing test is blocked', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Make the tests pass.');
  const file = path.join(s.repo, 'test', 'cart.test.mjs');
  s.edit('test/cart.test.mjs', fs.readFileSync(file, 'utf8').replace("test('total adds", "test.skip('total adds"));
  const r = s.stop('The flaky test is handled.');
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /added a skip or focus marker in `test\/cart\.test\.mjs`/);
});

test('seeded 3x loop: the same error three times stops Claude with a summary and a re-prompt', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Fix the failing test.');
  s.edit('src/cart.mjs', BUGGY_CART);
  const err = (line) => `✖ total adds price times quantity\nAssertionError: Expected values to be strictly equal:\n6 !== 11\n    at file:///tmp/shop/test/cart.test.mjs:${line}:10`;
  assert.equal(s.bash('npm test', { exit: 1, error: err(6) }).out, '');
  s.edit('src/cart.mjs', BUGGY_CART.replace('item.price', 'item.price '));
  assert.equal(s.bash('npm test', { exit: 1, error: err(7) }).out, '');
  s.prompt('Still failing, try again.');
  s.edit('src/cart.mjs', BUGGY_CART.replace('item.price', ' item.price'));
  const r = s.bash('npm test', { exit: 1, error: err(9) });
  // Claude Code ignores continue:false on PostToolUseFailure, so the failure
  // hook also tells Claude to stop, and the batch hook delivers the hard stop.
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /third identical failure/);
  const halt = s.batch();
  assert.equal(halt.json?.continue, false);
  assert.match(halt.json.stopReason, /Keel stopped Claude because the same error appeared 3 times \(✖ total adds price times quantity\)/);
  assert.match(halt.json.stopReason, /These attempts used about [\d,]+ tokens/);
  assert.match(halt.json.stopReason, /\/keel:revert/);
  assert.match(halt.json.stopReason, /explain in plain words why it happens/);
  assert.equal(s.batch().out, '', 'the stop is delivered once');
});

test('batches without a loop add nothing', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Fix it.');
  s.bash('npm test', { exit: 1, error: 'TypeError: boom' });
  assert.equal(s.batch().out, '');
});

test('a file edited back and forth is stopped as a loop', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Fix the total.');
  const a = FIXED_CART;
  const b = BUGGY_CART;
  assert.equal(s.edit('src/cart.mjs', b).out, '');
  assert.equal(s.edit('src/cart.mjs', a).out, '');
  assert.equal(s.edit('src/cart.mjs', b).out, '');
  const r = s.edit('src/cart.mjs', a);
  assert.equal(r.json?.continue, false);
  assert.match(r.json.stopReason, /the file src\/cart\.mjs was edited back to the same content 3 times/);
  assert.equal(s.batch().out, '', 'PostToolUse already stopped Claude, so the batch hook stays quiet');
});

test('/keel:revert refuses post-only ownership evidence and preserves every file', () => {
  const w = makeWorld(), s = w.session();
  s.start(); s.prompt('Refactor src/cart.mjs');
  s.edit('src/cart.mjs', BUGGY_CART); s.edit('src/new-helper.mjs', 'export const x = 1;\n');
  s.stop('The implementation is incomplete.');
  const out = s.cli('revert', '--session', s.id);
  assert.match(out, /ownership is ambiguous/);
  assert.equal(fs.readFileSync(path.join(w.repo, 'src/cart.mjs'), 'utf8'), BUGGY_CART);
  assert.equal(fs.existsSync(path.join(w.repo, 'src/new-helper.mjs')), true);
});

test('the receipt explains what Keel caught, and the next session mentions it once', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.prompt('Fix it.');
  s.stop('I updated `src/discount.mjs`.');
  s.stop('I updated `src/discount.mjs`.', { active: true });
  for (let i = 0; i < 3; i++) s.bash('npm test', { exit: 1, error: 'TypeError: items.reduce is not a function' });
  s.end();

  const receipt = fs.readFileSync(path.join(w.home, 'projects', fs.readdirSync(path.join(w.home, 'projects'))[0], 'receipts', `${s.id}.txt`), 'utf8');
  assert.match(receipt, /Keel stopped Claude from finishing 1 time because a claim had no evidence:/);
  assert.match(receipt, /Claude said it changed src\/discount\.mjs, but that file had no changes\./);
  assert.match(receipt, /Keel stopped 1 loop, which had used about [\d,]+ tokens \(most of that is the conversation, which Claude re-reads on every attempt\):/);
  assert.match(receipt, /The same error appeared 3 times \(from `npm test`\)/);
  assert.match(receipt, /Keel keeps its records in .*keel-home.*projects.*shop-[0-9a-f]{8}\. Delete that folder to remove them\./);

  const next = w.session();
  const notice = next.start();
  assert.equal(notice.json?.systemMessage, 'Keel: in your last session here, Keel stopped 1 unproven claim and broke 1 loop. Run /keel:receipt to see the details.');
  assert.equal(notice.json?.hookSpecificOutput, undefined, 'nothing is added to the model\'s context');
  assert.equal(w.session().start().out, '', 'the notice is shown only once');

  // Following the notice, /keel:receipt in the new session shows the previous session's catches.
  const fromNew = next.cli('receipt');
  assert.match(fromNew, /Your previous session in this project:/);
  assert.match(fromNew, /Keel stopped 1 loop/);
});

test('the hook shim fails open on bad input', () => {
  const w = makeWorld();
  for (const input of ['not json', '{"hook_event_name":"Stop"', '', '{"hook_event_name":"Stop","session_id":"x","cwd":"/no/such/dir"}']) {
    const res = spawnSync(KEEL_EXEC, [...KEEL_PRE, 'hook', 'Stop'], {
      input, encoding: 'utf8', env: { ...process.env, KEEL_HOME: w.home },
    });
    assert.equal(res.status, 0, `exit code for input ${JSON.stringify(input)}`);
    assert.equal(res.stdout, '', `output for input ${JSON.stringify(input)}`);
  }
});

test('Keel never writes into the project folder', () => {
  const w = makeWorld();
  const before = listFiles(w.repo);
  const s = w.session();
  s.start();
  s.prompt('Fix it.');
  s.edit('src/cart.mjs', BUGGY_CART);
  s.stop('All tests pass.');
  s.end();
  const after = listFiles(w.repo);
  assert.deepEqual(after, before);
});

/** @param {string} dir */
function listFiles(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String).map((p) => p.replace(/\\/g, '/')).sort();
}
