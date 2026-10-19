// Pure data models for the Keel VS Code / Cursor extension:
//   1. Status Bar Pill + Rich Markdown Hover Card
//   2. Native Sidebar TreeView (Task Budget & Plan, Checkpoints + Child Files, Guardrails)
//   3. GitLens-style CodeLens items above modified functions
//   4. Error Lens-style inline gate failure decorations on offending lines
//   5. Cursor-style floating diff review bar model

import path from 'node:path';
import { loadConfig, projectSettings } from './store.mjs';
import { budgetStatus, cumulativeUsage } from './budget.mjs';
import { summarise, planning } from './receipt.mjs';
import { status as currentStatus } from './status.mjs';
import { listSessionCheckpoints, compactTokens, relativeAge, progressBar, createPalette } from './tui.mjs';

/**
 * Builds the bottom-right Status Bar item model and rich Markdown hover tooltip.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {{nowMs?: number}} [opts]
 */
export function buildStatusBarModel(store, opts = {}) {
  const session = store.listSessions()[0];
  const events = session ? store.readSession(session) : [];
  const start = events.find((e) => e.kind === 'session_start');
  const settings = projectSettings(loadConfig(), store.root);
  const usage = start?.transcript ? cumulativeUsage(start.agent || 'claude-code', start.transcript) : null;
  const b = budgetStatus(events, usage, settings.budgets, settings.budgetUnits);
  const sum = summarise(events);
  const st = currentStatus(store);

  const pct = b ? Math.round(b.fraction * 100) : 0;
  const size = b?.size || 'idle';
  const used = b?.used || 0;
  const budget = b?.budget || settings.budgets.feature || 450000;
  const greenLabel = sum.lastGreen
    ? `● Green ${relativeAge(sum.lastGreen.t, opts.nowMs)}`
    : st.verdict === 'failed'
      ? '■ Gate Blocked'
      : '◌ No Green Yet';

  const text = b
    ? `⚓ Keel: ${size} ${pct}% · ${greenLabel}`
    : `⚓ Keel: ${greenLabel}`;

  const severity = st.verdict === 'failed' || (b && b.fraction >= 0.9)
    ? 'error'
    : (b && b.fraction >= 0.7)
      ? 'warning'
      : 'normal';

  const tooltipLines = [
    '**⚓ Keel Session Guardrails (v0.6.1)**',
    '',
    '```text',
    `Task Size  : ${size} (${compactTokens(budget)} cap)`,
    `Budget     : ${compactTokens(used)} / ${compactTokens(budget)} (${pct}%)`,
    `Last Green : ${sum.lastGreen ? `★ turn-${sum.lastGreen.turn || 1}-end (${relativeAge(sum.lastGreen.t, opts.nowMs)})` : 'none yet'}`,
    `Guard      : ${settings.guard.mode} · Loop Radar: ${sum.loops.length}/${settings.loopThreshold}`,
    '```',
    '',
    '[⟲ Revert to Green](command:keel.revert) &nbsp;&nbsp; [🍒 Cherry-Pick Files](command:keel.cherryPick) &nbsp;&nbsp; [↶ Undo Revert](command:keel.undo)',
  ];

  return {
    text,
    severity,
    size,
    pct,
    used,
    budget,
    lastGreenTurn: sum.lastGreen?.turn ?? null,
    tooltipMarkdown: tooltipLines.join('\n'),
  };
}

/**
 * Builds the 3-section Native Sidebar TreeView model (`KEEL: GUARDRAILS & TIMELINE`).
 * @param {import('./store.mjs').ProjectStore} store
 * @param {{nowMs?: number}} [opts]
 */
export function buildSidebarTreeModel(store, opts = {}) {
  const session = store.listSessions()[0];
  const events = session ? store.readSession(session) : [];
  const start = events.find((e) => e.kind === 'session_start');
  const settings = projectSettings(loadConfig(), store.root);
  const usage = start?.transcript ? cumulativeUsage(start.agent || 'claude-code', start.transcript) : null;
  const b = budgetStatus(events, usage, settings.budgets, settings.budgetUnits);
  const sum = summarise(events);
  const plan = planning(events);
  const cpData = listSessionCheckpoints(store, session);
  const plainPalette = createPalette({ color: false });

  const pct = b ? Math.round(b.fraction * 100) : 0;
  const size = b?.size || 'feature';
  const used = b?.used || 0;
  const budget = b?.budget || settings.budgets[size] || 450000;

  return {
    budgetAndPlan: {
      id: 'budget-and-plan',
      label: `TASK BUDGET & PLAN (${size.toUpperCase()})`,
      description: `${pct}%`,
      children: [
        {
          id: 'weighted-tokens',
          label: `Tokens: ${ progressBar(b?.fraction || 0, 10, plainPalette) }`,
          description: `${compactTokens(used)} / ${compactTokens(budget)} (${pct}%)`,
        },
        {
          id: 'plan-checks',
          label: plan.checks > 0 ? `✓ Plan Checked (${plan.checks})` : '○ Plan Check Pending',
          description: plan.held > 0 ? `${plan.held} held` : 'ready',
        },
        {
          id: 'test-gate-step',
          label: sum.keelChecks.length > 0 || sum.agentTests.length > 0 ? '✓ Test Verification Armed' : '● Run project test suite',
          description: `${sum.keelChecks.filter((c) => c.ok).length}/${sum.keelChecks.length || sum.agentTests.length} pass`,
        },
      ],
    },
    checkpoints: {
      id: 'checkpoints',
      label: `CHECKPOINTS (${cpData.checkpoints.length})`,
      description: cpData.checkpoints[0]?.id || 'none',
      children: cpData.checkpoints.map((cp, idx) => ({
        id: `cp-${cp.id}`,
        checkpointId: cp.id,
        commit: cp.commit,
        kind: cp.kind,
        label: `${cp.kind === 'green' ? '★' : cp.kind === 'gate' ? '■' : cp.kind === 'warn' ? '▲' : '○'} ${cp.id}`,
        description: `${cp.badge} · ${relativeAge(cp.t, opts.nowMs)}`,
        files: idx === 0 || cp.kind !== 'baseline'
          ? cpData.files.map((f) => ({
              id: `cp-${cp.id}-${f.path}`,
              path: f.path,
              status: f.status,
              label: `${f.status} ${f.path}`,
              description: `+${f.added} -${f.removed}`,
              added: f.added,
              removed: f.removed,
            }))
          : [],
      })),
    },
    guardrails: {
      id: 'guardrails',
      label: 'GUARDRAILS & HOOKS',
      description: settings.guard.mode,
      children: [
        {
          id: 'guard-mode',
          label: '🛡 Command Guard',
          description: settings.guard.mode,
        },
        {
          id: 'loop-radar',
          label: '🔁 Loop Breaker Radar',
          description: `${sum.loops.length} / ${settings.loopThreshold} repeats`,
        },
        {
          id: 'done-gate',
          label: '🧪 Done-Gate Verifier',
          description: settings.runChecks ? 'Tests + Diff' : 'Diff Only',
        },
      ],
    },
  };
}

/**
 * Computes changed line intervals (1-indexed) between beforeText and afterText.
 * @param {string} beforeText
 * @param {string} afterText
 */
function changedLineRange(beforeText, afterText) {
  const a = String(beforeText || '').replace(/\r\n/g, '\n').split('\n');
  const b = String(afterText || '').replace(/\r\n/g, '\n').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endB = b.length - 1;
  let endA = a.length - 1;
  while (endB >= start && endA >= start && b[endB] === a[endA]) {
    endB--;
    endA--;
  }
  return { startLine: start + 1, endLine: Math.max(start + 1, endB + 1) };
}

/**
 * Builds GitLens-style CodeLens items above modified functions/classes in `filePath`.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {string} filePath
 * @param {string} [fileContent]
 */
export function buildCodeLensModel(store, filePath, fileContent) {
  const rel = path.isAbsolute(filePath)
    ? path.relative(store.root, filePath).replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');
  const cpData = listSessionCheckpoints(store);
  const fileEntry = cpData.files.find((f) => f.path === rel);
  if (!fileEntry) return [];

  const text = fileContent ?? fileEntry.afterText ?? '';
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const { startLine, endLine } = changedLineRange(fileEntry.beforeText, fileEntry.afterText);
  const topCp = cpData.checkpoints[0];
  const cpLabel = topCp ? `${topCp.id} (${topCp.badge})` : 'current session';

  const fnRegex = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|class\s+([A-Za-z0-9_$]+)|(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(|def\s+([A-Za-z0-9_]+)|fn\s+([A-Za-z0-9_]+))/;
  /** @type {{line: number, symbol: string, title: string, commands: {title: string, command: string, arguments: any[]}[]}[]} */
  const lenses = [];

  for (let i = 0; i < lines.length; i++) {
    const m = fnRegex.exec(lines[i]);
    if (!m) continue;
    const symbol = m[1] || m[2] || m[3] || m[4] || m[5] || 'block';
    const lineNum = i + 1;
    if (lineNum <= endLine && lineNum + 25 >= startLine) {
      lenses.push({
        line: lineNum,
        symbol,
        title: `⚓ Keel: Modified in ${cpLabel} · +${fileEntry.added} -${fileEntry.removed}`,
        commands: [
          {
            title: `⚓ Keel: Modified in ${cpLabel} (+${fileEntry.added} -${fileEntry.removed})`,
            command: 'keel.compareWithBaseline',
            arguments: [rel],
          },
          {
            title: '⟲ Restore File',
            command: 'keel.cherryPickFile',
            arguments: [rel],
          },
          {
            title: '⇄ Compare with Baseline',
            command: 'keel.compareWithBaseline',
            arguments: [rel],
          },
        ],
      });
    }
  }

  if (!lenses.length) {
    lenses.push({
      line: Math.max(1, startLine),
      symbol: path.basename(rel),
      title: `⚓ Keel: Modified in ${cpLabel} · +${fileEntry.added} -${fileEntry.removed}`,
      commands: [
        {
          title: `⚓ Keel: Modified in ${cpLabel} (+${fileEntry.added} -${fileEntry.removed})`,
          command: 'keel.compareWithBaseline',
          arguments: [rel],
        },
        {
          title: '⟲ Restore File',
          command: 'keel.cherryPickFile',
          arguments: [rel],
        },
      ],
    });
  }

  return lenses;
}

/**
 * Builds Error Lens-style inline gate diagnostic decorations for `filePath`.
 * When a `turn_end` was blocked or has findings, or a check failed, attaches
 * an inline red diagnostic annotation to the relevant line.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {string} filePath
 */
export function buildErrorLensModel(store, filePath) {
  const rel = path.isAbsolute(filePath)
    ? path.relative(store.root, filePath).replace(/\\/g, '/')
    : filePath.replace(/\\/g, '/');
  const session = store.listSessions()[0];
  if (!session) return [];
  const events = store.readSession(session);
  const lastEnd = [...events].reverse().find((e) => e.kind === 'turn_end');
  if (!lastEnd) return [];

  const cpData = listSessionCheckpoints(store, session);
  const fileEntry = cpData.files.find((f) => f.path === rel);
  const fallbackLine = fileEntry ? changedLineRange(fileEntry.beforeText, fileEntry.afterText).startLine : 1;

  /** @type {{file: string, line: number, message: string, severity: 'error'|'warning'}[]} */
  const decorations = [];
  const findings = lastEnd.findings || [];

  for (const f of findings) {
    const summary = String(f.summary || 'Unverified completion claim');
    const escapedBase = path.basename(rel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineMatch = new RegExp(`${escapedBase}:(\\d+)`).exec(summary);
    if (lineMatch || fileEntry) {
      decorations.push({
        file: rel,
        line: lineMatch ? Number(lineMatch[1]) : fallbackLine,
        message: `✖ Keel Gate: ${summary}${lastEnd.blocked ? ' — False "done" blocked' : ''}`,
        severity: lastEnd.blocked ? 'error' : 'warning',
      });
    }
  }

  return decorations;
}

/**
 * Builds the Cursor-style bottom floating diff review bar model for the active editor.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {string} [activeFilePath]
 */
export function buildReviewBarModel(store, activeFilePath) {
  const cpData = listSessionCheckpoints(store);
  const rel = activeFilePath
    ? (path.isAbsolute(activeFilePath) ? path.relative(store.root, activeFilePath) : activeFilePath).replace(/\\/g, '/')
    : cpData.files[0]?.path || null;
  const idx = cpData.files.findIndex((f) => f.path === rel);
  const activeIdx = idx >= 0 ? idx : 0;
  const current = cpData.files[activeIdx] || null;

  return {
    visible: cpData.files.length > 0,
    fileIndex: current ? activeIdx + 1 : 0,
    totalFiles: cpData.files.length,
    currentFile: current?.path || null,
    added: current?.added || 0,
    removed: current?.removed || 0,
    actions: [
      { id: 'restoreFile', label: '🍒 Restore This File', command: 'keel.cherryPickFile', args: [current?.path] },
      { id: 'revertAll', label: '⟲ Revert All to Last Green', command: 'keel.revert', args: [] },
      { id: 'undo', label: '↶ Undo Last Revert', command: 'keel.undo', args: [] },
    ],
  };
}
