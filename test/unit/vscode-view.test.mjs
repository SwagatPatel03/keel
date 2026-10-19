import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderBody, renderPage, ago, compact, esc, budgetLabel } = require('../../vscode-extension/view.cjs');

const NOW = Date.parse('2026-10-20T12:00:00Z');

const SAMPLE = {
  v: 1,
  project: { name: 'shop', root: '/work/shop' },
  store: { dir: '/home/a/.keel/projects/shop-1', shadow: '/home/a/.keel/projects/shop-1/shadow.git', base: 'abc1234' },
  session: 's1',
  prompts: 3,
  verdict: { value: 'failed', reasons: ['unit: 2 tests failed'], checks: [{ id: 'unit', verdict: 'failed', passed: 10, total: 12, failed: 2, skipped: 0 }], at: '2026-10-20T11:57:00Z', source: 'verify' },
  task: { prompt: 3, size: 'small', fraction: 0.82, used: 73800, budget: 90000, unit: 'weighted', newTokens: 20000 },
  lastGreen: { prompt: 1, at: '2026-10-20T11:00:00Z' },
  timeline: [
    { prompt: 3, at: '2026-10-20T11:57:00Z', kind: 'failed', files: 2, summary: 'Checks failed' },
    { prompt: 1, at: '2026-10-20T11:00:00Z', kind: 'green', files: 1, summary: 'Checks passed' },
  ],
  changes: [
    { path: 'src/cart.mjs', status: 'M', added: 4, removed: 1 },
    { path: 'test/<script>.mjs', status: 'A', added: 18, removed: 0 },
  ],
  guard: { mode: 'beginner', refused: 1, asked: 0, recent: [{ decision: 'refuse', rule: 'delete-home', what: 'rm -rf ~', at: '2026-10-20T11:30:00Z' }] },
  catches: { claims: 0, loops: 0 },
  learn: 'on',
};

test('the sidebar shows the verdict, its counts, the budget, the prompts, the files and the guard', () => {
  const html = renderBody(SAMPLE, { now: NOW });
  assert.match(html, /Checks failed/);
  assert.match(html, /10\/12 passed, 2 failed/);
  assert.match(html, /unit: 2 tests failed/);
  assert.match(html, /Checked 3m ago/);
  assert.match(html, /<strong>82%<\/strong>/);
  assert.match(html, /class="fill-mid" width="82%"/, 'past 70% the bar turns to the warning color');
  assert.match(html, /x="70%"/);
  assert.match(html, /x="90%"/);
  assert.match(html, /last green: prompt 1/);
  assert.match(html, /data-cmd="diff" data-arg="src\/cart\.mjs"/);
  assert.match(html, /data-cmd="previewUndo"/);
  assert.match(html, /refused<\/span><code title="rm -rf ~">rm -rf ~<\/code>/);
});

test('file names and commands from the records are escaped, never run as markup', () => {
  const html = renderBody(SAMPLE, { now: NOW });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;\.mjs/);
  assert.equal(esc(`"'<&>`), '&quot;&#39;&lt;&amp;&gt;');
});

test('the page allows only its own script and styles, and uses no inline style attributes', () => {
  const page = renderPage(renderBody(SAMPLE, { now: NOW }), { nonce: 'N0NCE' });
  assert.match(page, /default-src 'none'; style-src 'nonce-N0NCE'; script-src 'nonce-N0NCE';/);
  assert.doesNotMatch(page, /\sstyle="/, 'the policy would block these');
  assert.match(page, /<script nonce="N0NCE">/);
  assert.doesNotMatch(page, /https?:\/\//, 'nothing is loaded from the internet');
});

test('first-run pages say what to do next', () => {
  assert.match(renderBody(null, { keelFound: false }), /\/plugin install keel@keel/);
  assert.match(renderBody({ ...SAMPLE, prompts: 0 }, {}), /Keel is watching shop/);
  assert.match(renderBody(null, { noFolder: true }), /Open a folder/);
  assert.match(renderBody(SAMPLE, { now: NOW, busy: 'Running the checks' }), /Running the checks…/);
  assert.match(renderBody(SAMPLE, { now: NOW, error: 'bad <json>' }), /bad &lt;json&gt;/);
});

test('a verified session with no budget yet still draws cleanly', () => {
  const html = renderBody({ ...SAMPLE, verdict: { ...SAMPLE.verdict, value: 'verified', reasons: [] }, task: null, changes: [], guard: { ...SAMPLE.guard, recent: [] } }, { now: NOW });
  assert.match(html, /Verified/);
  assert.doesNotMatch(html, /Budget/);
  assert.match(html, /No files changed yet/);
  assert.match(html, /Nothing refused or asked about/);
});

test('ages and counts read plainly', () => {
  assert.equal(ago('2026-10-20T11:59:50Z', NOW), 'just now');
  assert.equal(ago('2026-10-20T09:00:00Z', NOW), '3h ago');
  assert.equal(ago('2026-10-19T09:00:00Z', NOW), 'yesterday');
  assert.equal(ago(null, NOW), '');
  assert.equal(compact(36900), '37k');
  assert.equal(compact(1263631), '1.3M');
  assert.deepEqual([0.41, 1.4, 2.5, 62.73].map(budgetLabel), ['41%', '140%', '2.5× budget', '63× budget']);
});
