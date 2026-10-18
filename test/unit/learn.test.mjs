import '../isolate-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDebuggingPrompt, learningMoment, fixedFailure, dependencies, learningRequest, learnSummary } from '../../src/learn.mjs';
import { sizeTask } from '../../src/sizer.mjs';
import { LABELLED } from './sizer.test.mjs';

test('only the debugging prompts among the 20 labelled prompts are tagged', () => {
  const tagged = LABELLED.filter(([p]) => isDebuggingPrompt(p, sizeTask(p).size)).map(([p]) => p);
  assert.deepEqual(tagged, [
    'The cart total shows NaN when an item has no quantity, fix it in src/cart.js',
    'The /api/orders endpoint returns 500 after I add a coupon',
  ]);
});

test('debugging tags: error text, crashes and fix-plus-symptom; never trivial or quick:', () => {
  const tag = (p) => isDebuggingPrompt(p, sizeTask(p).size);
  assert.equal(tag('The checkout page crashes'), true);
  assert.equal(tag('TypeError: items.reduce is not a function'), true);
  assert.equal(tag('npm test fails with "expected 11, got 5"'), true);
  assert.equal(tag('Getting this:\n    at total (src/cart.mjs:4:16)'), true);
  assert.equal(tag('Fix the typo in the error message'), false, 'trivial');
  assert.equal(tag('quick: the checkout page crashes'), false, 'quick:');
  assert.equal(tag('fix the login bug'), false, 'no symptom: clarity questions come first');
  assert.equal(tag('Add a search bar to the products page'), false);
  assert.equal(tag('Rename total to cartTotal in src/cart.mjs'), false);
});

test('a failing test fixed by an edit is a learning moment; a flaky pass without an edit is not', () => {
  const fail = { isTest: true, ok: false, exitCode: 1, command: 'npm test' };
  const pass = { isTest: true, ok: true, exitCode: 0, command: 'npm test' };
  const edit = { files: ['src/cart.mjs'] };
  assert.equal(fixedFailure([fail, edit, pass]), 'npm test');
  assert.equal(fixedFailure([fail, pass]), null, 'no edit in between');
  assert.equal(fixedFailure([pass, edit, pass]), null, 'never failed');
  assert.equal(fixedFailure([fail, edit, fail]), null, 'still failing');
  assert.equal(fixedFailure([fail, edit]), null);
});

test('dependencies are read from six kinds of manifest', () => {
  assert.deepEqual(dependencies('package.json', '{"dependencies":{"zod":"^3"},"devDependencies":{"vitest":"1"}}'), ['zod', 'vitest']);
  assert.deepEqual(dependencies('api/requirements.txt', 'requests[socks]>=2.0  # http\n-r base.txt\nflask==3.0\n'), ['requests', 'flask']);
  assert.deepEqual(dependencies('pyproject.toml', '[project]\nname = "x"\ndependencies = [\n  "httpx>=0.27",\n  "pydantic[email]>=2",\n]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nrich = "^13"\n'), ['rich', 'httpx', 'pydantic']);
  assert.deepEqual(dependencies('Cargo.toml', '[package]\nname = "x"\n\n[dependencies]\nserde = { version = "1" }\ntokio = "1"\n\n[dev-dependencies]\ninsta = "1"\n'), ['serde', 'tokio', 'insta']);
  assert.deepEqual(dependencies('go.mod', 'module x\n\nrequire github.com/a/b v1.0.0\nrequire (\n\tgithub.com/c/d v0.2.0 // indirect\n)\n'), ['github.com/a/b', 'github.com/c/d']);
  assert.deepEqual(dependencies('Gemfile', "source 'https://rubygems.org'\ngem 'rails', '~> 7'\n  gem \"pg\"\n"), ['rails', 'pg']);
  assert.deepEqual(dependencies('package.json', '{ half written'), []);
});

test('learning moments: new dependency first, then a first file of a new kind, then a fixed failure', () => {
  const files = {
    before: { 'package.json': '{"dependencies":{"express":"4"}}' },
    after: { 'package.json': '{"dependencies":{"express":"4","zod":"3"}}' },
  };
  const read = (f, side) => files[side][f] ?? null;
  const fixed = [{ isTest: true, ok: false, command: 'npm test' }, { files: ['a.js'] }, { isTest: true, ok: true, command: 'npm test' }];

  assert.deepEqual(learningMoment({ toolResults: fixed, changes: [{ status: 'M', path: 'package.json' }], read, filesBefore: [] }), { tag: 'dependency', names: ['zod'] });
  assert.deepEqual(learningMoment({ toolResults: [], changes: [{ status: 'A', path: 'Dockerfile' }], read, filesBefore: ['src/a.js'] }), { tag: 'new-file', kind: 'Dockerfile' });
  assert.equal(learningMoment({ toolResults: [], changes: [{ status: 'A', path: 'api/Dockerfile' }], read, filesBefore: ['web/Dockerfile'] }), null, 'not the first Dockerfile');
  assert.deepEqual(learningMoment({ toolResults: [], changes: [{ status: 'A', path: '.github/workflows/ci.yml' }], read, filesBefore: [] }), { tag: 'new-file', kind: 'CI workflow' });
  assert.deepEqual(learningMoment({ toolResults: [], changes: [{ status: 'A', path: 'db/migrations/001_init.sql' }], read, filesBefore: [] }), { tag: 'new-file', kind: 'database migration' });
  assert.deepEqual(learningMoment({ toolResults: fixed, changes: [{ status: 'M', path: 'a.js' }], read, filesBefore: [] }), { tag: 'fixed-failure', command: 'npm test' });
  assert.deepEqual(learningMoment({ toolResults: fixed, changes: null, read, filesBefore: null }), { tag: 'fixed-failure', command: 'npm test' }, 'works without a checkpoint');
  assert.equal(learningMoment({ toolResults: [], changes: [{ status: 'M', path: 'a.js' }], read, filesBefore: [] }), null);
});

test('the learning request names what is new and asks for one open question', () => {
  const dep = learningRequest({ tag: 'dependency', names: ['zod'] });
  assert.match(dep, /added a new dependency \(zod\)\. Add a short section titled "What is new"/);
  assert.match(dep, /one short open question/);
  assert.match(dep, /do not change any files/);
  assert.match(learningRequest({ tag: 'dependency', names: ['zod', 'vitest', 'tsx'] }), /\(zod, vitest and tsx\)/);
  assert.match(learningRequest({ tag: 'fixed-failure', command: 'npm test' }), /`npm test` failed and then passed after your edits\. Add a short section titled "What was wrong"/);
  assert.match(learningRequest({ tag: 'new-file', kind: 'Dockerfile' }), /the project's first Dockerfile/);
});

test('the receipt line counts each kind of note', () => {
  assert.equal(learnSummary([]), null);
  assert.equal(learnSummary([{ tag: 'debugging' }]), 'Keel asked for 1 learning note: 1 on a debugging prompt.');
  assert.equal(
    learnSummary([{ tag: 'debugging' }, { tag: 'fixed-failure' }, { tag: 'dependency', names: ['zod'] }, { tag: 'new-file', fileKind: 'Dockerfile' }]),
    'Keel asked for 4 learning notes: 1 on a debugging prompt, 1 on a test failure Claude fixed, 1 on a new dependency (zod) and 1 on a new kind of file (Dockerfile).',
  );
});
