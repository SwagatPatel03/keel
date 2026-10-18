// Phase 4, replayed through the real hook shim: learning notes on debugging
// prompts, learning requests for moments found mid-turn, the opt-out, the
// one-time notice, the receipt line, and Codex.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, FIXED_CART, BUGGY_CART } from './harness.mjs';

const PKG = (deps) => JSON.stringify({ name: 'keel-seeded-repo', private: true, type: 'module', scripts: { test: 'node --test' }, ...(deps ? { dependencies: deps } : {}) }, null, 2) + '\n';

test('default behaviour is unchanged: a clear, non-debugging turn prints nothing at any hook', () => {
  const s = makeWorld().session();
  for (const r of [
    s.start(),
    s.prompt('Rename total to cartTotal in src/cart.mjs'),
    s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small')),
    s.bash('npm test', { stdout: '# pass 3' }),
    s.batch(),
    s.stop('Renamed it, and all tests pass.'),
  ]) {
    assert.equal(r.status, 0);
    assert.equal(r.out, '');
  }
});

test('a debugging prompt gets the learning note once, and the stop adds nothing more', () => {
  const s = makeWorld().session();
  s.start();
  const r = s.prompt('The cart total shows NaN when an item has no quantity, fix it in src/cart.mjs');
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.equal(r.json.hookSpecificOutput.additionalContext, '[Keel] Learning note: this looks like a debugging task. Work exactly as you normally would. When you finish, add a short section titled "What was wrong" with 2 to 3 plain sentences: the root cause, how you found it, and how to spot this kind of bug next time. Then ask the user one short open question that checks they understood the cause. Do not give the answer until they reply. If they answer in their next message, start your reply by telling them in one or two sentences whether they were right, and correct anything they missed.');
  // The agent debugs: a failing run, an edit, a passing run. The note was already asked for, so no second request.
  s.bash('npm test', { exit: 1, error: 'not ok 3 - an item with no quantity counts as one' });
  s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small'));
  s.bash('npm test', { stdout: '# pass 3' });
  assert.equal(s.stop('Fixed it, and all tests pass.\n\nWhat was wrong: ...\n\nQuick question: ...?').out, '');
  assert.match(s.cli('receipt'), /Keel asked for 1 learning note: 1 on a debugging prompt\./);
});

test('a test failure the agent fixed mid-turn gets one learning request after the evidence gate', () => {
  const s = makeWorld().session();
  s.start();
  assert.equal(s.prompt('Rename total to cartTotal in src/cart.mjs').out, '');
  s.edit('src/cart.mjs', BUGGY_CART);
  s.bash('npm test', { exit: 1, error: 'not ok 1 - total adds price times quantity' });
  s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small'));
  s.bash('npm test', { stdout: '# pass 3' });
  const first = s.stop('Renamed it, and all tests pass.');
  assert.equal(first.json?.decision, 'block');
  assert.match(first.json.reason, /^\[Keel\] Before you finish: during this turn `npm test` failed and then passed after your edits\. Add a short section titled "What was wrong"/);
  assert.equal(s.stop('What was wrong: ... Question: ...?', { active: true }).out, '', 'asked once only');
  assert.equal(s.stop('Anything else?').out, '', 'not again in the same prompt');
  assert.match(s.cli('receipt'), /Keel asked for 1 learning note: 1 on a test failure Claude fixed\./);
});

test('a new dependency and a first Dockerfile each get a "What is new" request', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.prompt('Validate cart items in src/cart.mjs so a bad price is rejected');
  s.edit('package.json', PKG({ zod: '^3.23.0' }));
  s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A validated'));
  s.bash('npm test', { stdout: '# pass 3' });
  const dep = s.stop('Done: prices are validated with zod, and all tests pass.');
  assert.equal(dep.json?.decision, 'block');
  assert.match(dep.json.reason, /this turn added a new dependency \(zod\)\. Add a short section titled "What is new" with 2 to 3 plain sentences: what zod does/);

  s.prompt('Package the app in src/ so it runs in a container');
  s.edit('Dockerfile', 'FROM node:22-alpine\nCOPY . .\nCMD ["node", "src/cart.mjs"]\n');
  const docker = s.stop('Added a Dockerfile.');
  assert.equal(docker.json?.decision, 'block');
  assert.match(docker.json.reason, /this turn added the project's first Dockerfile/);

  s.prompt('Change the Dockerfile to use node 20 in src/ builds');
  s.edit('Dockerfile', 'FROM node:20-alpine\nCOPY . .\nCMD ["node", "src/cart.mjs"]\n');
  assert.equal(s.stop('Switched to node 20.').out, '', 'an edited Dockerfile is not new');

  const receipt = s.cli('receipt');
  assert.match(receipt, /Keel asked for 2 learning notes: 1 on a new dependency \(zod\) and 1 on a new kind of file \(Dockerfile\)\./);
  // Only tags and package names are stored.
  const sessions = path.join(w.home, 'projects', fs.readdirSync(path.join(w.home, 'projects'))[0], 'sessions');
  const learn = fs.readFileSync(path.join(sessions, fs.readdirSync(sessions)[0]), 'utf8').split('\n').filter((l) => l.includes('"kind":"learn"'));
  assert.equal(learn.length, 2);
  assert.ok(learn.every((l) => !/container|validated|price/i.test(l)), 'no prompt text is stored');
});

test('the evidence gate goes first; after a gate block, no learning request is made', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Rename total to cartTotal in src/cart.mjs');
  s.bash('npm test', { exit: 1, error: 'not ok 1 - total adds price times quantity' });
  s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small'));
  s.bash('npm test', { stdout: '# pass 3' });
  const gate = s.stop('I updated `src/discount.mjs` and all tests pass.');
  assert.equal(gate.json?.decision, 'block');
  assert.match(gate.json.reason, /src\/discount\.mjs/);
  assert.doesNotMatch(gate.json.reason, /What was wrong/);
  assert.equal(s.stop('Sorry, I only changed src/cart.mjs.', { active: true }).out, '');
});

test('/keel:learn off silences notes and requests; "here" sets one project only', () => {
  const s = makeWorld().session();
  s.start();
  assert.match(s.cli('learn'), /^Keel learning notes are on in this project\./);
  assert.match(s.cli('learn', 'off'), /^Keel learning notes are now off for all your projects\.\nRun \/keel:learn on to get/);
  assert.equal(s.prompt('The checkout page crashes when the cart is empty').out, '');
  s.bash('npm test', { exit: 1, error: 'not ok 1' });
  s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small'));
  s.bash('npm test', { stdout: '# pass 3' });
  assert.equal(s.stop('Fixed, and all tests pass.').out, '');

  assert.match(s.cli('learn', 'on', 'here'), /^Keel learning notes are now on for this project/);
  assert.match(s.prompt('The checkout page crashes when the cart is empty').json?.hookSpecificOutput?.additionalContext, /Learning note/);
  assert.match(s.cli('learn', 'off'), /This project has its own setting, so they stay on here\./);
});

test('the one-time notice tells a new user how to turn notes off, once per machine', () => {
  const w = makeWorld({ firstRun: true });
  const first = w.session().start().json;
  assert.deepEqual(first, { systemMessage: 'Keel: Keel adds a short explanation and one question on debugging turns and when something new is added to your project. If you do not want them, run /keel:learn off.' });
  assert.equal(w.session().start().out, '', 'not shown again');
  assert.ok(fs.existsSync(path.join(w.home, 'learn-notice-shown')));

  const quiet = makeWorld({ firstRun: true });
  quiet.config({ learn: { mode: 'off' } });
  assert.equal(quiet.session().start().out, '', 'no notice when notes are already off');
});

test('Codex: the first note carries the off switch, then a mid-turn request works', () => {
  const w = makeWorld({ firstRun: true });
  const c = w.codex();
  // codex exec does not print hook messages, so the notice rides on the first note instead.
  assert.equal(c.start().out, '');

  const first = c.prompt('npm test fails with "expected 11, got 5" in src/cart.mjs').json?.hookSpecificOutput?.additionalContext;
  assert.match(first, /^\[Keel\] Learning note: this looks like a debugging task\./);
  // The Node.js edition names node and its script; a compiled Keel names its own executable.
  assert.match(first, /After your question, add this sentence for the user, word for word: "Keel asked for this note\. To turn these notes off, run (node ".*keel\.mjs"|\S*keel(\.exe)?) learn off in a terminal\."$/);
  const second = c.prompt('npm test fails with "expected 11, got 5" in src/cart.mjs').json?.hookSpecificOutput?.additionalContext;
  assert.doesNotMatch(second, /turn these notes off/, 'only once per machine');

  assert.equal(c.prompt('Add zod to package.json for validating src/cart.mjs input').out, '');
  c.patch('package.json', PKG({ zod: '^3.23.0' }));
  c.bash('npm test', { exit: 0, output: '# pass 3' });
  const stop = c.stop('Added zod, and all tests pass.');
  assert.equal(stop.json?.decision, 'block');
  assert.match(stop.json.reason, /this turn added a new dependency \(zod\)/);
  assert.equal(c.stop('What is new: ... ?', { active: true }).out, '');
});
