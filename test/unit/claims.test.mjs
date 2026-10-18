import test from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims } from '../../src/claims.mjs';

test('finds a tests-pass claim', () => {
  for (const msg of [
    'All tests pass.',
    'I fixed the bug and the tests now pass.',
    'All 12 tests passed with no failures.',
    'The test suite is green.',
    'Ran the suite: tests passing ✅',
  ]) {
    assert.ok(extractClaims(msg).tests, msg);
  }
});

test('ignores hedged, negated or instructional test sentences', () => {
  for (const msg of [
    'I could not run the tests, so please run npm test.',
    'The tests do not pass yet.',
    'Once you run the tests, they should pass if the API is up.',
    'Tests are failing on the discount case.',
    'You can run npm test to verify.',
  ]) {
    assert.equal(extractClaims(msg).tests, null, msg);
  }
});

test('finds build and done claims', () => {
  assert.ok(extractClaims('The build succeeds without errors.').build);
  assert.ok(extractClaims('It compiles cleanly now.').build);
  assert.ok(extractClaims('I fixed the rounding bug.').done);
  assert.ok(extractClaims('Done.').done);
  assert.ok(extractClaims('Everything works as expected now.').done);
  assert.equal(extractClaims('This is not fixed yet; the cause is unclear.').done, null);
});

test('finds files the agent says it changed, not files it only mentions', () => {
  const c = extractClaims('I updated `src/cart.mjs` so that total() uses `src/money.mjs` for rounding.');
  assert.deepEqual(c.files.map((f) => f.path), ['src/cart.mjs']);
});

test('reads file claims from list items', () => {
  const c = extractClaims([
    'Changes:',
    '- `src/cart.mjs`: fixed the total for empty carts',
    '- **test/cart.test.mjs** — added a test for discounts',
    '- README.md is unchanged',
  ].join('\n'));
  assert.deepEqual(c.files.map((f) => f.path), ['src/cart.mjs', 'test/cart.test.mjs']);
});

test('keeps dotted file names whole and strips line anchors', () => {
  const c = extractClaims('I edited cart.test.mjs:14 and nothing else.');
  assert.deepEqual(c.files.map((f) => f.path), ['cart.test.mjs']);
});

test('ignores code blocks and URLs', () => {
  const c = extractClaims('See https://example.com/docs/setup.html.\n```\nI updated fake.js\n```\nNothing changed.');
  assert.deepEqual(c.files, []);
});

test('an empty message has no claims', () => {
  assert.deepEqual(extractClaims(''), { tests: null, build: null, done: null, files: [] });
  assert.deepEqual(extractClaims(null), { tests: null, build: null, done: null, files: [] });
});
