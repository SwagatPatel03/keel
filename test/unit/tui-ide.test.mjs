import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectStore } from '../../src/store.mjs';
import { Shadow } from '../../src/checkpoint.mjs';
import { makeEvent } from '../../src/events.mjs';
import { undoTransaction } from '../../src/transactions.mjs';
import {
  createPalette,
  progressBar,
  renderDeltaDiff,
  listSessionCheckpoints,
  cherryPickRevert,
  renderClackRevertView,
  renderClackStatus,
  renderClaudeHookNotice,
  renderStatusline,
} from '../../src/tui.mjs';
import {
  buildStatusBarModel,
  buildSidebarTreeModel,
  buildCodeLensModel,
  buildErrorLensModel,
  buildReviewBarModel,
} from '../../src/ide-bridge.mjs';

function makeFixtureProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-tui-ide-'));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, 'cart.mjs'),
    [
      'export function calculateSubtotal(items) {',
      '  return items.reduce((sum, item) => sum + item.price * item.qty, 0);',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(srcDir, 'checkout.mjs'),
    [
      'export function submitOrder(cart) {',
      '  return cart.items.length > 0;',
      '}',
      '',
    ].join('\n'),
  );

  const store = new ProjectStore(dir).ensure();
  const shadow = new Shadow(store).init();
  const session = 'sess-ui-1';
  const baseCommit = shadow.snapshot(session, 'turn-1-start');

  store.append(
    makeEvent('session_start', { agent: 'claude-code', session }, { cwd: dir, transcript: null }),
  );
  store.append(
    makeEvent(
      'turn_start',
      { agent: 'claude-code', session, turn: 1 },
      { n: 1, size: 'feature', checkpoint: baseCommit, usageBase: { units: 0, newTokens: 0, output: 0 } },
    ),
  );

  // Modify both files in the working tree
  fs.writeFileSync(
    path.join(srcDir, 'cart.mjs'),
    [
      'export function calculateSubtotal(items, filter = {}) {',
      '  const visible = items.filter((item) => !filter.sku || item.sku === filter.sku);',
      '  return visible.reduce((sum, item) => sum + Math.round(item.price * item.qty * 100) / 100, 0);',
      '}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(srcDir, 'checkout.mjs'),
    [
      'export function submitOrder(cart) {',
      '  if (!cart.items.length) throw new Error("Empty cart");',
      '  return true;',
      '}',
      '',
    ].join('\n'),
  );

  const endCommit = shadow.snapshot(session, 'turn-1-end', baseCommit);
  shadow.markGreen(session, endCommit);

  store.append(
    makeEvent(
      'tool_result',
      { agent: 'claude-code', session, turn: 1 },
      {
        tool: 'Edit',
        ok: true,
        files: ['src/cart.mjs', 'src/checkout.mjs'],
        beforeCheckpoint: baseCommit,
        afterCheckpoint: endCommit,
      },
    ),
  );
  store.append(
    makeEvent(
      'turn_end',
      { agent: 'claude-code', session, turn: 1 },
      {
        v: 2,
        verdict: 'verified',
        green: true,
        blocked: false,
        checkpoint: endCommit,
        changedFiles: 2,
        keelChecks: [{ id: 'test', ok: true }],
        findings: [],
      },
    ),
  );

  return { dir, store, session, baseCommit, endCommit };
}

test('Clack tree-rail renderer and git-delta word-level diff format checkpoints and hunks cleanly', () => {
  const { store, session } = makeFixtureProject();
  const cpData = listSessionCheckpoints(store, session);
  assert.equal(cpData.files.length, 2);
  assert.equal(cpData.checkpoints[0].kind, 'green');
  assert.match(cpData.checkpoints[0].badge, /last green/);

  const view = renderClackRevertView(
    {
      projectName: 'keel-demo',
      size: 'feature',
      fraction: 0.412,
      used: 185400,
      budget: 450000,
      checkpoints: cpData.checkpoints,
      files: cpData.files,
      selectedCpIndex: 0,
      selectedFiles: [true, false],
      focusedFileIndex: 0,
    },
    { color: false },
  );

  assert.match(view, /┌\s+\[keel revert\] keel-demo/);
  assert.match(view, /◇\s+Task · feature\s+━━━━────── 41% \(185\.4k \/ 450k\)/);
  assert.match(view, /◆\s+Select a checkpoint to restore/);
  assert.match(view, /● turn-1-end\s+★ last green/);
  assert.match(view, /◆\s+Cherry-pick files to restore \(Space to toggle · 1\/2 selected\)/);
  assert.match(view, /◼ M src\/cart\.mjs/);
  assert.match(view, /◻ M src\/checkout\.mjs/);
  assert.match(view, /── git-delta preview: src\/cart\.mjs/);

  const diffColored = renderDeltaDiff(
    'const total = price * qty;\n',
    'const total = Math.round(price * qty);\n',
    'src/cart.mjs',
    { color: true },
  );
  assert.match(diffColored, /git-delta preview: src\/cart\.mjs/);
  assert.match(diffColored, /\x1b\[48;5;/, 'contains ANSI background highlights for word-level diff');
});

test('cherryPickRevert selectively restores only chosen files and supports undoTransaction', () => {
  const { dir, store, session } = makeFixtureProject();
  const cartPath = path.join(dir, 'src', 'cart.mjs');
  const checkoutPath = path.join(dir, 'src', 'checkout.mjs');

  // Cherry-pick restore ONLY src/cart.mjs
  const tx = cherryPickRevert(store, session, { files: ['src/cart.mjs'] });
  assert.equal(tx.state, 'applied');
  assert.deepEqual(tx.entries.map((e) => e.path), ['src/cart.mjs']);

  // src/cart.mjs is reverted to baseline, while src/checkout.mjs keeps its new changes!
  assert.doesNotMatch(fs.readFileSync(cartPath, 'utf8'), /filter\.sku/);
  assert.match(fs.readFileSync(checkoutPath, 'utf8'), /Empty cart/);

  // Undo the cherry-pick revert restores src/cart.mjs back to the modified state
  const undone = undoTransaction(store);
  assert.equal(undone.state, 'applied');
  assert.match(fs.readFileSync(cartPath, 'utf8'), /filter\.sku/);
});

test('Clack status, Claude Code hook connector, and 1-line statusline HUD render expected output', () => {
  const { store } = makeFixtureProject();
  const statusOut = renderClackStatus(store, { color: false });
  assert.match(statusOut, /┌\s+\[keel status\]/);
  assert.match(statusOut, /◆\s+Session Budget/);
  assert.match(statusOut, /◆\s+Guardrails & Recovery/);
  assert.match(statusOut, /★ turn-1-end/);

  const hookOut = renderClaudeHookNotice(
    'warn',
    'Bash(git reset --hard HEAD~1)',
    ['⚓ Keel Guard [beginner]: Paused destructive git command.'],
    { color: false },
  );
  assert.match(hookOut, /▲ Bash\(git reset --hard HEAD~1\)\n\s+⎿\s+⚓ Keel Guard/);

  const hud = renderStatusline(store, {}, { color: false });
  assert.match(hud, /⚓ keel │ .* │ ● last green: .* │ guard: beginner/);
  assert.equal(progressBar(0.5, 10, createPalette({ color: false })), '━━━━━─────');
});

test('VS Code / Cursor IDE bridge builds Status Bar, TreeView, GitLens CodeLens, Error Lens, and Review Bar models', () => {
  const { dir, store, session, endCommit } = makeFixtureProject();

  const sb = buildStatusBarModel(store);
  assert.match(sb.text, /⚓ Keel:/);
  assert.match(sb.tooltipMarkdown, /command:keel\.revert/);
  assert.match(sb.tooltipMarkdown, /command:keel\.cherryPick/);

  const tree = buildSidebarTreeModel(store);
  assert.match(tree.budgetAndPlan.label, /TASK BUDGET & PLAN/);
  assert.equal(tree.checkpoints.children[0].files.length, 2);
  assert.equal(tree.guardrails.children.length, 3);

  const cartFile = path.join(dir, 'src', 'cart.mjs');
  const lenses = buildCodeLensModel(store, cartFile, fs.readFileSync(cartFile, 'utf8'));
  assert.equal(lenses.length, 1);
  assert.equal(lenses[0].symbol, 'calculateSubtotal');
  assert.match(lenses[0].title, /⚓ Keel: Modified in turn-1-end/);

  const reviewBar = buildReviewBarModel(store, cartFile);
  assert.equal(reviewBar.visible, true);
  assert.equal(reviewBar.fileIndex, 1);
  assert.equal(reviewBar.totalFiles, 2);
  assert.equal(reviewBar.currentFile, 'src/cart.mjs');

  // Append a blocked turn_end with a finding on cart.mjs:2 to verify Error Lens decorations
  store.append(
    makeEvent(
      'turn_end',
      { agent: 'claude-code', session, turn: 2 },
      {
        v: 2,
        verdict: 'failed',
        green: false,
        blocked: true,
        checkpoint: endCommit,
        changedFiles: 1,
        findings: [{ summary: 'AssertionError in cart.mjs:2 (expected 39.98)' }],
      },
    ),
  );
  const errorLens = buildErrorLensModel(store, cartFile);
  assert.equal(errorLens.length, 1);
  assert.equal(errorLens[0].line, 2);
  assert.match(errorLens[0].message, /✖ Keel Gate: AssertionError in cart\.mjs:2.*False "done" blocked/);
});
