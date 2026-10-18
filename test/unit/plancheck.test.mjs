import '../isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPlan } from '../../src/plancheck.mjs';
import { scopeHashes } from '../../src/sizer.mjs';

const GOOD = `# Search bar plan

## Phase 1: Filter logic
1. Add \`filterProducts(products, query)\` to \`src/products/filter.js\`; an empty query returns all products.
2. Write tests in \`test/filter.test.js\` for matches, no matches and an empty query.

## Phase 2: Search box
3. Add a search input to \`src/products/ProductsPage.jsx\` that calls filterProducts.
4. Run the tests and check the page by hand.
`;

test('a complete plan has no gaps and gets a checklist', () => {
  // filter.js is a new file, so it is part of the feature rather than out of scope.
  const exists = (p) => p !== 'src/products/filter.js';
  const r = checkPlan(GOOD, { scope: scopeHashes('Add a search bar to src/products/ProductsPage.jsx'), size: 'feature', exists });
  assert.deepEqual(r.gaps, []);
  assert.deepEqual(r.questions, []);
  assert.equal(r.phases, 2);
  assert.equal(r.tasks, 4);
  assert.equal(r.checklist[0], 'Phase 1: Filter logic');
  assert.ok(r.checklist.some((l) => l.startsWith('Write tests in test/filter.test.js')));
});

test('a plan with no test step is flagged with a senior-style question', () => {
  const r = checkPlan('## Plan\n1. Add a dark mode toggle to the settings page.\n2. Store the choice.');
  assert.deepEqual(r.gaps.map((g) => g.kind), ['no-test']);
  assert.match(r.questions[0], /How should we check that this works/);
});

test('a plan that handles uploads without saying what happens on failure is flagged', () => {
  const r = checkPlan('1. Add an upload form for profile images.\n2. Save the file to disk.\n3. Add a test for the happy path.');
  assert.deepEqual(r.gaps.map((g) => g.kind), ['no-error-handling']);
  assert.match(r.questions[0], /What should happen when the upload part fails/);
});

test('files outside the request are flagged; test files are not', () => {
  const scope = scopeHashes('Fix the total in src/cart.js');
  const r = checkPlan('1. Fix total() in src/cart.js.\n2. Add a case to test/cart.test.js.\n3. Update src/checkout/payment.js to match.\n4. Run the tests.', { scope });
  assert.deepEqual(r.gaps.map((g) => g.kind), ['out-of-scope']);
  assert.match(r.gaps[0].finding, /`src\/checkout\/payment\.js`/);
  assert.doesNotMatch(r.gaps[0].finding, /cart\.test/);
});

test('with no paths in the request, only sensitive files count as out of scope', () => {
  const r = checkPlan('1. Add the chart to src/Dashboard.jsx.\n2. Add VITE_KEY to .env.\n3. Run the tests.');
  assert.deepEqual(r.gaps.map((g) => g.kind), ['out-of-scope']);
  assert.match(r.gaps[0].finding, /`\.env`/);
});

test('guesses are quoted back as a question', () => {
  const r = checkPlan('1. The orders API probably returns dates in UTC, so no conversion is needed.\n2. Run the tests.');
  assert.ok(r.gaps.some((g) => g.kind === 'assumption'));
  assert.match(r.questions.join(' '), /The plan assumes: "The orders API probably returns dates in UTC/);
});

test('risky plans must say how to undo them', () => {
  const plan = '1. Write a migration that drops legacy_users.\n2. Run the tests.';
  assert.ok(checkPlan(plan, { size: 'risky' }).gaps.some((g) => g.kind === 'no-rollback'));
  assert.ok(!checkPlan(plan + '\n3. Keep a backup and a down migration to roll back.', { size: 'risky' }).gaps.some((g) => g.kind === 'no-rollback'));
  assert.ok(!checkPlan(plan, { size: 'feature' }).gaps.some((g) => g.kind === 'no-rollback'));
});

test('plans bigger than 3 phases of 3 tasks are flagged', () => {
  const steps = Array.from({ length: 11 }, (_, i) => `- [ ] Step ${i + 1}: do part ${i + 1} and test it`).join('\n');
  const r = checkPlan(steps);
  assert.deepEqual(r.gaps.map((g) => g.kind), ['too-big']);
  assert.match(r.questions[0], /This plan has 11 tasks/);
});

test('never more than three questions', () => {
  const r = checkPlan('1. Upload the CSV to the API.\n2. Change .env and package-lock.json.\n3. This should be fine, I think.', { size: 'risky' });
  assert.ok(r.gaps.length > 3);
  assert.equal(r.questions.length, 3);
});
