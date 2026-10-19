// Phase 2 exit criteria, replayed through the real hook shim:
//   - small tasks run with no ceremony (no output, so no tokens);
//   - feature tasks get a plan check with 1 to 3 questions before approval.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, FIXED_CART } from './harness.mjs';
import { BROWSER_BLOCK, QUESTION } from '../unit/prompttext.test.mjs';

const NO_TEST_PLAN = `# Search bar

## Phase 1: Search
1. Add a search input to src/cart.mjs that filters items by name.
2. Show the filtered list.
`;

const GOOD_PLAN = `# Search bar

**Goal:** filter cart items by name.

## Phase 1: Search
1. Add filterItems(items, query) to src/cart.mjs; an empty query returns all items.
2. Add tests in test/cart.test.mjs for a match, no match and an empty query.
3. Run npm test.
`;

test('trivial and small prompts get no ceremony: every hook prints nothing', () => {
  const s = makeWorld().session();
  assert.equal(s.start().out, '');
  for (const p of [
    'Fix the typo in the README title',
    'Rename total to cartTotal in src/cart.mjs',
    'Add a missing null check in total so it returns 0 for an empty list in src/cart.mjs',
    'quick: add a dashboard with charts',
    // A debugging prompt gets a learning note (see learning.test.mjs), unless quick: is used.
    'quick: The cart total shows NaN when an item has no quantity, fix it in src/cart.mjs',
  ]) {
    const r = s.prompt(p);
    assert.equal(r.status, 0);
    assert.equal(r.out, '', `expected no output for: ${p}`);
    s.edit('src/cart.mjs', FIXED_CART.replace('// A tiny', `// ${p.length}`));
    s.bash('npm test', { stdout: '# pass 3' });
    assert.equal(s.stop('Done, and all tests pass.').out, '');
  }
});

test('a feature prompt is told to plan first, and the plan guide it points to exists', () => {
  const s = makeWorld().session();
  s.start();
  const r = s.prompt('Add a search bar to the products page that filters by name');
  const ctx = r.json?.hookSpecificOutput?.additionalContext;
  assert.equal(r.json?.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
  assert.match(ctx, /sized as a feature \(add a search\)/);
  assert.match(ctx, /enter plan mode/);
  assert.match(ctx, /at most 3 phases of at most 3 tasks/);
  const guide = /read (.+SKILL\.md)/.exec(ctx)?.[1];
  assert.ok(guide && fs.existsSync(guide), `plan guide should exist: ${guide}`);
  assert.doesNotMatch(ctx, /Because this is risky/);
});

test('agent-generated prompts and slash commands are not sized or questioned', () => {
  const s = makeWorld().session();
  s.start();
  assert.match(s.prompt('Add a search bar to the products page that filters by name').out, /sized as a feature/);
  const note = s.prompt('<task-notification>\n<task-id>a46d</task-id>\n<result>fix: the cart has no name field</result>\n</task-notification>');
  assert.equal(note.out, '', 'a background task finishing adds nothing');
  assert.equal(s.prompt('/keel:receipt').out, '', 'a slash command adds nothing');
  assert.match(s.cli('receipt'), /Keel sized 1 prompt: 0 trivial or small \(no planning and no extra tokens\), 1 feature\./);
});

test('a risky prompt also gets safeguards', () => {
  const s = makeWorld().session();
  s.start();
  const ctx = s.prompt('Add Stripe payments to the checkout').json?.hookSpecificOutput?.additionalContext;
  assert.match(ctx, /sized as a risky change \(stripe\)/);
  assert.match(ctx, /say what could be lost or broken and how to undo it/);
});

test('a vague prompt with two signs gets clarity questions; one sign does not', () => {
  const s = makeWorld().session();
  s.start();
  const ctx = s.prompt('fix the login bug').json?.hookSpecificOutput?.additionalContext;
  assert.match(ctx, /This request is unclear \(no symptom is described; it is very short\)/);
  assert.match(ctx, /AskUserQuestion/);
  assert.match(ctx, /1\) What happens now, and what did you expect to happen instead\?/);
  // One sign only: no clarity questions. A crash is a debugging prompt, so only the learning note is added.
  const crash = s.prompt('The checkout page crashes').json?.hookSpecificOutput?.additionalContext;
  assert.doesNotMatch(crash, /unclear/);
  assert.match(crash, /^\[Keel\] Learning note: this looks like a debugging task\./);
});

test('a real question with an extension\'s block in front, an answer with headings, and a "Yes" reply: Keel adds nothing', () => {
  const s = makeWorld().session();
  s.start();
  // The extension's text named files and debugging; only the question counts.
  assert.equal(s.prompt(`${BROWSER_BLOCK}${QUESTION}`).out, '');
  // An answer with headings, a table and numbered tips is not a plan, so the stop is not held.
  const answer = [
    'Keel works by itself: once it is installed, it runs on every prompt through its hooks.',
    '', '## What happens without you doing anything', '', '| When | What Keel does |', '| --- | --- |', '| Claude says done | Keel checks the claim |',
    '', '## Commands', '', '- `/keel:receipt` shows a summary', '- `/keel:revert` puts files back',
    '', '## Three optional things', '', '1. Start a new session.', '2. Try `git reset --hard` in a throwaway folder; secret files such as `.env` are protected.', '3. Create `~/.keel/config.json` for settings.',
    '', '## Next', '', 'Shall I fix the bug?',
  ].join('\n');
  assert.equal(s.stop(answer).out, '');
  // The user's "Yes" continues that conversation: no clarity questions.
  assert.equal(s.prompt('Yes').out, '');
});

test('in plan mode a vague prompt gets no clarity questions from Keel, because plan mode asks its own', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.mode = 'plan';
  const out = s.prompt('fix the login bug').json?.hookSpecificOutput?.additionalContext || '';
  assert.doesNotMatch(out, /unclear|AskUserQuestion/);
  const projects = path.join(w.home, 'projects');
  const stored = fs.readdirSync(projects).flatMap((p) => fs.readdirSync(path.join(projects, p, 'sessions')).map((f) => fs.readFileSync(path.join(projects, p, 'sessions', f), 'utf8'))).join('');
  assert.match(stored, /"planMode":true[^\n]*"clarity":\{"signs":\[[^\]]+\],"asked":false\}/, 'the signs are still recorded');
});

test('plan check at approval: a plan with gaps is held once with questions, then shown with a checklist', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Add a search bar to the cart that filters by name');
  assert.equal(s.writePlan(NO_TEST_PLAN).out, '');
  const first = s.exitPlan();
  const out = first.json?.hookSpecificOutput;
  assert.equal(out?.permissionDecision, 'deny');
  assert.match(out.permissionDecisionReason, /No step says how the change will be tested/);
  const questions = out.permissionDecisionReason.match(/^\d\) /gm) || [];
  assert.ok(questions.length >= 1 && questions.length <= 3, `1 to 3 questions, got ${questions.length}`);
  assert.match(out.permissionDecisionReason, /call ExitPlanMode again/);

  s.askUser();
  s.writePlan(GOOD_PLAN);
  const second = s.exitPlan();
  assert.equal(second.json?.hookSpecificOutput, undefined, 'not held a second time');
  assert.match(second.json?.systemMessage, /Keel: the plan in plain words/);
  assert.match(second.json.systemMessage, /Add tests in test\/cart\.test\.mjs/);
  assert.match(second.json.systemMessage, /a test step: yes/);
});

test('the plan check also finds plans in the folder the project\'s plansDirectory setting names', () => {
  const s = makeWorld().session();
  fs.mkdirSync(path.join(s.repo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, '.claude', 'settings.json'), JSON.stringify({ plansDirectory: './docs/plans' }));
  s.plans = path.join(s.repo, 'docs', 'plans');
  fs.mkdirSync(s.plans, { recursive: true });
  s.start();
  s.prompt('Add a search bar to the cart that filters by name');
  s.writePlan(NO_TEST_PLAN);
  const out = s.exitPlan().json?.hookSpecificOutput;
  assert.equal(out?.permissionDecision, 'deny', 'the plan was found and held');
  assert.match(out.permissionDecisionReason, /No step says how the change will be tested/);
});

test('a plan held once is never held again in the same prompt, even with gaps left', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Add a search bar to the cart that filters by name');
  s.writePlan(NO_TEST_PLAN);
  assert.equal(s.exitPlan().json?.hookSpecificOutput?.permissionDecision, 'deny');
  const again = s.exitPlan();
  assert.equal(again.json?.hookSpecificOutput, undefined);
  assert.match(again.json?.systemMessage, /a test step: no/);
});

test('a plan turn without ExitPlanMode is checked when it stops', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Add a search bar to the cart that filters by name');
  s.writePlan(NO_TEST_PLAN);
  const r = s.stop('Here is the plan. I have not edited any files.');
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /present it again for approval/);
  assert.equal(s.stop('Updated plan above.', { active: true }).out, '');
});

test('in plan mode the plan is checked even if another tool wrote files in the project', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Add a search bar to the cart that filters by name');
  fs.mkdirSync(path.join(s.repo, '.toolcache', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(s.repo, '.toolcache', 'sessions', 'x.json'), '{}');
  s.writePlan(NO_TEST_PLAN);
  const r = s.stop('Here is the plan.');
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /No step says how the change will be tested/);
});

test('a plan posted in chat (no plan file) is checked when it stops', () => {
  const s = makeWorld().session();
  s.start();
  s.prompt('Add a search bar to the cart that filters by name');
  const r = s.stop('Plan:\n1. Add a search input.\n2. Filter the items.\n3. Show the results.');
  assert.equal(r.json?.decision, 'block');
  assert.match(r.json.reason, /No step says how the change will be tested/);
});

test('Keel stores no prompt, plan or plan-file name', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.prompt('Add a search bar using key sk-test-1234567890abcdef to the zebra-catalogue page');
  s.writePlan(NO_TEST_PLAN.replace('Show the filtered list.', 'Show the flamingo list.'), 'add-a-search-bar-zebra-catalogue.md');
  s.exitPlan();
  s.end();
  const stored = readAll(w.home);
  for (const secret of ['sk-test-1234567890abcdef', 'zebra', 'flamingo', 'search bar', 'quirky']) {
    assert.ok(!stored.includes(secret), `"${secret}" must not be stored`);
  }
  assert.match(stored, /"kind":"plan_check"/);
  assert.match(stored, /"gaps":\["no-test"\]/);
});

test('the receipt reports sizing, clarity and plan checks', () => {
  const w = makeWorld();
  const s = w.session();
  s.start();
  s.prompt('Fix the typo in the README title');
  s.stop('Fixed.');
  s.prompt('fix the login bug');
  s.stop('Which page do you mean?');
  s.prompt('Add a search bar to the cart that filters by name');
  s.writePlan(NO_TEST_PLAN);
  s.exitPlan();
  s.askUser();
  s.writePlan(GOOD_PLAN);
  s.exitPlan();
  const receipt = s.cli('receipt');
  assert.match(receipt, /Keel sized 3 prompts: 2 trivial or small \(no planning and no extra tokens\), 1 feature\./);
  assert.match(receipt, /1 prompt looked unclear, so Claude was asked to check with you before starting\./);
  assert.match(receipt, /Keel checked 2 plans and held 1 for 1 question before approval \(gaps found: no test step\)\./);
  assert.match(receipt, /Claude asked you questions 1 time\./);
});

/** @param {string} dir */
function readAll(dir) {
  let text = '';
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (full.includes('shadow.git')) continue; // checkpoints hold project files, not prompts
    text += fs.readFileSync(full, 'utf8');
  }
  return text;
}
