// Phase 3, replayed through the real hook shim: the guard, protected paths,
// the token budget with its meter, and the Codex adapter end to end.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeWorld, FIXED_CART, BUGGY_CART, KEEL_EXEC, KEEL_PRE } from './harness.mjs';

test('guard in Claude Code: ask (with a checkpoint), refuse, and let everyday calls through silently', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.prompt('Clean up the cart code in src/cart.mjs');

  const reset = s.pre('Bash', { command: 'git reset --hard' }).json?.hookSpecificOutput;
  assert.equal(reset?.permissionDecision, 'ask');
  assert.equal(reset.permissionDecisionReason, 'Keel: git reset --hard throws away all uncommitted changes in tracked files. Safer: git stash keeps the changes so you can get them back. Keel saved a checkpoint first, so /keel:revert can bring back project files.');
  const shadow = path.join(w.home, 'projects', fs.readdirSync(path.join(w.home, 'projects'))[0], 'shadow.git');
  const refs = execFileSync('git', [`--git-dir=${shadow}`, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' });
  assert.match(refs, /before-risky-\d+/, 'a checkpoint was saved before asking');

  const home = s.pre('Bash', { command: 'sudo rm -rf ~' }).json?.hookSpecificOutput;
  assert.equal(home?.permissionDecision, 'deny');
  assert.match(home.permissionDecisionReason, /^Keel refused this command: rm -r ~ would permanently delete your whole home folder/);

  assert.equal(s.pre('Read', { file_path: path.join(s.repo, '.env') }).json?.hookSpecificOutput?.permissionDecision, 'ask');
  assert.equal(s.pre('Edit', { file_path: path.join(s.repo, '.git', 'config') }).json?.hookSpecificOutput?.permissionDecision, 'deny');

  for (const [tool, input] of [['Bash', { command: 'npm test' }], ['Bash', { command: 'rm -rf node_modules' }], ['Read', { file_path: path.join(s.repo, 'src', 'cart.mjs') }], ['Edit', { file_path: path.join(s.repo, 'src', 'cart.mjs') }]]) {
    assert.equal(s.pre(tool, input).out, '', `${tool} ${JSON.stringify(input)} should pass silently`);
  }

  const receipt = s.cli('receipt');
  assert.match(receipt, /Keel refused 2 dangerous commands and asked you first about 2:/);
  assert.match(receipt, /Refused: sudo rm -rf ~/);
  assert.match(receipt, /Asked about: git reset --hard/);
});

test('the guard stores only asked or refused calls, with secrets masked', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.prompt('Check the API');
  s.pre('Bash', { command: 'curl -H "Authorization: Bearer sk-live-abcdefghijklmnop" https://api.example.com' });
  s.pre('Bash', { command: 'rm -rf ~ && echo token=ghp_ABCDEFGHIJKLMNOPQRSTUV' });
  const projects = path.join(w.home, 'projects');
  const sessionsDir = path.join(projects, fs.readdirSync(projects)[0], 'sessions');
  const stored = fs.readdirSync(sessionsDir).map((f) => fs.readFileSync(path.join(sessionsDir, f), 'utf8')).join('');
  assert.ok(!stored.includes('sk-live-abcdefghijklmnop'), 'allowed commands are not stored');
  assert.ok(!stored.includes('api.example.com'), 'allowed commands are not stored');
  assert.ok(!stored.includes('ghp_ABCDEFGHIJKLMNOPQRSTUV'), 'secrets in refused commands are masked');
  assert.match(stored, /"kind":"guard","tool":"Bash","decision":"refuse"/);
});

test('budget warnings at 70%, 90% and 100% go to the user once each, and add nothing to Claude\'s context', () => {
  const w = makeWorld();
  // Each assistant message in the harness costs 2 input + 100 output + 500 cache-write = 602 new tokens.
  w.config({ budgets: { trivial: 6020 } });
  const s = w.session();
  s.start();
  s.prompt('Rename total to cartTotal in src/cart.mjs');
  const spend = (n) => { for (let i = 0; i < n; i++) s.toolUse('Read'); };

  spend(6); // 3,612 = 60%
  assert.equal(s.batch().out, '');
  spend(1); // 4,214 = 70%
  const at70 = s.batch().json;
  assert.deepEqual(Object.keys(at70), ['systemMessage']);
  assert.match(at70.systemMessage, /^Keel: this trivial task has used about 4,200 of its 6,000 new-token budget \(70%\)\.$/);
  assert.equal(s.batch().out, '', 'not repeated at the same level');
  spend(2); // 5,418 = 90%
  assert.match(s.batch().json.systemMessage, /\(90%\)\.$/);
  spend(1); // 6,020 = 100%
  assert.match(s.batch().json.systemMessage, /\(100%\)\. Claude will carry on; you can stop it at any time\.$/);
  spend(3);
  assert.equal(s.batch().out, '', 'no more warnings after 100%');

  // The meter, as Claude Code's status line would call it.
  const meter = spawnSync(KEEL_EXEC, [...KEEL_PRE, 'meter'], {
    input: JSON.stringify({ session_id: s.id, transcript_path: s.transcript, cwd: s.repo }),
    encoding: 'utf8', env: { ...process.env, KEEL_HOME: w.home },
  });
  assert.equal(meter.stdout.trim(), 'Keel: trivial task, about 7,800 of 6,000 new tokens (130%)');

  const receipt = s.cli('receipt');
  assert.match(receipt, /Token use per task \(new tokens, leaving out cache re-reads\):\n {2}- Prompt 1 \(trivial\): about 7,800 of 6,000 \(130%\)\./);
  assert.match(receipt, /Keel showed you 3 budget warnings\./);
});

test('weighted budgets: warnings in budget units, and an optional stop at 100% (Claude Code and Codex)', () => {
  const w = makeWorld();
  // Each harness message is 2 input + 500 cache-write + 10,000 cache-read + 100 output
  // = 2 + 625 + 1,000 + 500 = 2,127 units (602 new tokens).
  w.config({ budgets: { trivial: 10000, feature: 2000 }, budgetUnits: 'weighted', budget: { onLimit: 'stop' } });
  const s = w.session();
  s.start();
  s.prompt('Rename total to cartTotal in src/cart.mjs');
  const spend = (n) => { for (let i = 0; i < n; i++) s.toolUse('Read'); };
  spend(4); // 8,508 = 85%
  assert.equal(s.batch().json?.systemMessage, 'Keel: this trivial task has used about 85% of its budget (8,500 of 10,000 units; 2,400 new tokens, 400 of them output).');
  spend(1); // 10,635 = 106%: stopped once, through the batch hook
  const stop = s.batch().json;
  assert.equal(stop?.continue, false);
  assert.match(String(stop?.stopReason ?? stop?.systemMessage), /Keel is stopping the agent, as your budget setting asks/);
  assert.match(s.cli('receipt'), /Budget use per task \(budget units weigh output and cache use by price, as an estimate\):\n {2}- Prompt 1 \(trivial\): 106% \(11,000 of 10,000 units; 3,000 new tokens\)\.[\s\S]*Keel stopped the agent at its budget 1 time/);

  // Codex has no batch hook: the stop refuses the next tool call, and every one after it until the next prompt.
  const c = w.codex();
  c.start();
  c.prompt('Add a search bar to the products page that filters by name');
  c.spend(1500, 100); // 1,500 + 100 x 6 = 2,100 units of 2,000
  const first = c.pre('ls').json?.hookSpecificOutput;
  assert.equal(first?.permissionDecision, 'deny');
  assert.match(first.permissionDecisionReason, /Keel is stopping the agent, as your budget setting asks\. Tell the user/);
  assert.match(c.pre('ls').json?.hookSpecificOutput?.permissionDecisionReason, /^Keel stopped this task at its budget/);
  c.prompt('Thanks, that is enough for now. Summarise the search bar work in src/products.mjs');
  assert.equal(c.pre('ls').out, '', 'a new prompt starts a new budget');
});

test('a budget warning at the end of a turn rides along with the evidence gate', () => {
  const w = makeWorld();
  w.config({ budgets: { small: 1000 } });
  const s = w.session();
  s.start();
  s.prompt('The cart total shows NaN when an item has no quantity, fix it in src/cart.mjs');
  s.edit('src/cart.mjs', BUGGY_CART);
  const r = s.stop('I updated `src/discount.mjs`.');
  assert.equal(r.json?.decision, 'block', 'the gate still blocks');
  assert.match(r.json.systemMessage, /Keel: this small task has used about/);
});

test('Codex: sizing, guard, loop stop, evidence gate and budget through the real shim', () => {
  const w = makeWorld();
  w.config({ budgets: { feature: 2000, small: 100000 } });
  const c = w.codex();
  assert.equal(c.start().out, '');

  // A feature prompt gets plan-first guidance worded for Codex (no plan mode).
  const ctx = c.prompt('Add a search bar to the products page that filters by name').json?.hookSpecificOutput?.additionalContext;
  assert.match(ctx, /sized as a feature/);
  assert.match(ctx, /post a short plan/);
  assert.doesNotMatch(ctx, /ExitPlanMode/);

  // The guard: Codex cannot ask, so a dangerous command is paused with instructions to ask the user.
  const reset = c.pre('git reset --hard').json?.hookSpecificOutput;
  assert.equal(reset?.permissionDecision, 'deny');
  assert.match(reset.permissionDecisionReason, /^Keel paused this command: git reset --hard/);
  assert.match(reset.permissionDecisionReason, /ask whether they want to run it themselves/);

  // The budget: Codex has no batch hook, so warnings arrive before the next tool call.
  c.spend(1500, 100); // 1,600 of 2,000 = 80%
  assert.match(c.pre('ls').json?.systemMessage, /Keel: this feature task has used about 1,600 of its 2,000 new-token budget \(80%\)/);

  // A loop: three identical failures (exit codes read from the rollout).
  c.prompt('The cart total is wrong, fix src/cart.mjs so the tests pass');
  for (let i = 1; i <= 2; i++) assert.equal(c.bash('npm test', { exit: 1, output: `not ok 1 - total adds price times quantity\n# at line ${i}` }).out, '');
  const third = c.bash('npm test', { exit: 1, output: 'not ok 1 - total adds price times quantity\n# at line 9' }).json;
  assert.equal(third?.decision, 'block');
  assert.match(third.reason, /third identical failure/);
  assert.match(third.systemMessage, /Keel stopped Codex because the same error appeared 3 times/);
  const paused = c.pre('npm test').json?.hookSpecificOutput;
  assert.equal(paused?.permissionDecision, 'deny');
  assert.match(paused.permissionDecisionReason, /tool calls are paused until the user's next message/);

  // The next prompt lifts the pause; an edit and a false claim are caught by the evidence gate.
  c.prompt('ok, try once more: fix src/cart.mjs');
  assert.equal(c.pre('npm test').out, '');
  c.patch('src/cart.mjs', BUGGY_CART);
  const stop = c.stop('Fixed it. All tests pass.');
  assert.equal(stop.json?.decision, 'block');
  assert.match(stop.json.reason, /Keel ran `npm test` and it failed/);
  assert.equal(c.stop('Sorry, the tests still fail.', { active: true }).json?.decision, undefined);
});

test('Codex: a clear small prompt with a passing edit adds nothing', () => {
  const w = makeWorld();
  const c = w.codex();
  c.start();
  for (const r of [
    c.prompt('Rename total to cartTotal in src/cart.mjs'),
    c.pre('node --test'),
    c.patch('src/cart.mjs', FIXED_CART.replace('// A tiny', '// A small')),
    c.bash('npm test', { exit: 0, output: '# pass 3' }),
    c.stop('Renamed it, and all tests pass.'),
  ]) {
    assert.equal(r.status, 0);
    assert.equal(r.out, '');
  }
});
