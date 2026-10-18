import '../isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sizeTask, clarityCheck, scopeHashes, pathKeys } from '../../src/sizer.mjs';

// The plan's test set: 20 labelled prompts across trivial, small, feature and risky.
export const LABELLED = [
  ['Fix the typo in the README title', 'trivial'],
  ['Change the primary button colour to #2563eb', 'trivial'],
  ['Rename getUser to fetchUser in src/api.js', 'trivial'],
  ['Make the headline on the landing page say "Ship faster"', 'trivial'],
  ['Bump the padding on the navbar a bit', 'trivial'],
  ['The cart total shows NaN when an item has no quantity, fix it in src/cart.js', 'small'],
  ['fix the login bug', 'small'],
  ['Add a missing null check in parseDate so it returns null for empty strings', 'small'],
  ['The /api/orders endpoint returns 500 after I add a coupon', 'small'],
  ['Write a unit test for formatPrice', 'small'],
  ['Add a search bar to the products page that filters by name', 'feature'],
  ['Build a dashboard showing weekly sales with a chart', 'feature'],
  ['Implement image upload for user profiles', 'feature'],
  ['Create a new endpoint that exports orders as CSV', 'feature'],
  ['Refactor the checkout flow into separate components', 'feature'],
  ['Add Stripe payments to the checkout', 'risky'],
  ['Write a migration that drops the legacy_users table', 'risky'],
  ['Set up deploy to production on push to main', 'risky'],
  ['Add login with Google', 'risky'],
  ['make it better', 'small'],
];

test('sizes at least 18 of the 20 labelled prompts as labelled', () => {
  const misses = LABELLED.filter(([p, want]) => sizeTask(p).size !== want).map(([p, want]) => `${p} (want ${want}, got ${sizeTask(p).size})`);
  assert.ok(misses.length <= 2, `misses:\n${misses.join('\n')}`);
});

test('overrides win', () => {
  assert.equal(sizeTask('quick: add a dashboard with charts').size, 'small');
  assert.equal(sizeTask('plan: fix the rounding in total()').size, 'feature');
  assert.equal(sizeTask('PLAN: tidy up').override, 'plan');
});

test('risky files named in a prompt make it risky', () => {
  assert.equal(sizeTask('Update .github/workflows/ci.yml to cache node_modules').size, 'risky');
  assert.equal(sizeTask('Add a column to migrations/002_users.sql').size, 'risky');
});

test('naming three or more files makes a prompt a feature', () => {
  assert.equal(sizeTask('Move the helpers from src/a.js, src/b.js and src/c.js into src/util.js').size, 'feature');
});

test('clarity questions need two or more vague signs', () => {
  const login = clarityCheck('fix the login bug', 'small');
  assert.deepEqual(login.signs, ['no-symptom', 'too-short']);
  assert.equal(login.ask, true);

  const better = clarityCheck('make it better', 'small');
  assert.equal(better.ask, true);
  assert.ok(better.questions.length <= 3);

  // One sign only: no questions.
  assert.equal(clarityCheck('Fix the typo in the README title', 'trivial').ask, false);
  assert.equal(clarityCheck('The checkout page crashes', 'small').ask, false);

  // Clear prompts: no signs.
  assert.deepEqual(clarityCheck('The cart total shows NaN when an item has no quantity, fix it in src/cart.js', 'small').signs, []);
  assert.deepEqual(clarityCheck('Add a search bar to the products page that filters by name', 'feature').signs, []);
  assert.equal(clarityCheck('quick: fix it', 'small').ask, false);
});

test('scope hashes: a named file covers itself, a named folder covers its contents, and no text is kept', () => {
  const inScope = (prompt, file) => {
    const hashes = new Set(scopeHashes(prompt));
    return pathKeys(file).some((k) => hashes.has(k));
  };
  assert.equal(inScope('Fix the rounding in src/cart/total.js please', 'src/cart/total.js'), true);
  assert.equal(inScope('Fix the rounding in total.js please', 'src/cart/total.js'), true, 'file name alone matches');
  assert.equal(inScope('Fix the rounding in src/cart/total.js please', 'src/cart/discount.js'), false, 'a sibling file is not covered');
  assert.equal(inScope('Tidy up everything in src/cart/', 'src/cart/discount.js'), true, 'a named folder covers its files');
  assert.ok(scopeHashes('Fix src/a.js').every((h) => /^[0-9a-f]{12}$/.test(h)));
  assert.deepEqual(scopeHashes('no paths here'), []);
});

test('scope hashes are keyed per install, so the same file name gives a different value on another machine', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const before = process.env.KEEL_HOME;
  try {
    process.env.KEEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-key-a-'));
    const a = scopeHashes('Fix src/cart.js');
    assert.deepEqual(scopeHashes('Fix src/cart.js'), a, 'stable on one install');
    const key = fs.readFileSync(path.join(process.env.KEEL_HOME, 'install.key'), 'utf8');
    assert.match(key, /^[0-9a-f]{64}$/);
    process.env.KEEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-key-b-'));
    const b = scopeHashes('Fix src/cart.js');
    assert.notDeepEqual(b, a, 'another install gets other values');
    const plain = crypto.createHash('sha1').update('src/cart.js').digest('hex').slice(0, 12);
    assert.ok(!a.includes(plain) && !b.includes(plain), 'a plain hash of the name does not match');
  } finally {
    if (before === undefined) delete process.env.KEEL_HOME; else process.env.KEEL_HOME = before;
  }
});
