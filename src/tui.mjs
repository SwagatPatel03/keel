// Clack-style tree-rail CLI renderer, git-delta word-level diff preview, and
// Claude Code / OpenCode statusline HUD. Uses zero external dependencies.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Shadow } from './checkpoint.mjs';
import { checkpointPatch, sessionRevert, transact, undoTransaction, transactionText } from './transactions.mjs';
import { status as currentStatus } from './status.mjs';
import { loadConfig, projectSettings } from './store.mjs';
import { budgetStatus, cumulativeUsage } from './budget.mjs';
import { planning, summarise } from './receipt.mjs';
import { blob } from './workspace.mjs';

/**
 * @param {{color?: boolean}} [opts]
 */
export function createPalette(opts = {}) {
  const enabled = opts.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  const wrap = (open, close = '\x1b[0m') => (/** @type {string} */ s) => enabled ? `${open}${s}${close}` : String(s);
  return {
    enabled,
    rail: wrap('\x1b[38;5;240m'),
    pill: (/** @type {string} */ s) => enabled ? `\x1b[48;5;43m\x1b[38;5;232m\x1b[1m ${s} \x1b[0m` : `[${s}]`,
    cyan: wrap('\x1b[38;5;80m'),
    green: wrap('\x1b[38;5;78m'),
    amber: wrap('\x1b[38;5;214m'),
    red: wrap('\x1b[38;5;203m'),
    yellow: wrap('\x1b[38;5;221m'),
    muted: wrap('\x1b[38;5;245m'),
    bright: wrap('\x1b[1m\x1b[38;5;255m'),
    delLine: wrap('\x1b[48;5;52m\x1b[38;5;217m'),
    addLine: wrap('\x1b[48;5;22m\x1b[38;5;120m'),
    delWord: wrap('\x1b[48;5;88m\x1b[38;5;255m\x1b[1m', '\x1b[22m\x1b[48;5;52m\x1b[38;5;217m'),
    addWord: wrap('\x1b[48;5;28m\x1b[38;5;255m\x1b[1m', '\x1b[22m\x1b[48;5;22m\x1b[38;5;120m'),
  };
}

/**
 * Horizontal bar (`━━━━──────`) used in tree-rail headers and statuslines.
 * @param {number} fraction
 * @param {number} [width]
 * @param {ReturnType<typeof createPalette>} [c]
 */
export function progressBar(fraction, width = 10, c = createPalette({ color: false })) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  const activeColor = clamped >= 0.9 ? c.red : clamped >= 0.7 ? c.amber : c.green;
  return activeColor('━'.repeat(filled)) + c.rail('─'.repeat(Math.max(0, width - filled)));
}

/**
 * Formats compact token counts (`185.4k`, `450k`, `850`).
 * @param {number} n
 */
export function compactTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1000) {
    const k = Math.round((n / 1000) * 10) / 10;
    return (Number.isInteger(k) ? String(k) : k.toFixed(1)) + 'k';
  }
  return String(Math.round(n));
}

/**
 * Relative age string (`just now`, `3m ago`, `2h ago`).
 * @param {number|string|Date|null|undefined} when
 * @param {number} [nowMs]
 */
export function relativeAge(when, nowMs = Date.now()) {
  if (!when) return 'unknown';
  const ts = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : Date.parse(String(when));
  if (!Number.isFinite(ts)) return 'unknown';
  const sec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/**
 * Word-level inline diff highlight between one deleted and one added line.
 * @param {string} oldLine
 * @param {string} newLine
 * @param {ReturnType<typeof createPalette>} c
 */
function highlightWordPair(oldLine, newLine, c) {
  let prefix = 0;
  const minLen = Math.min(oldLine.length, newLine.length);
  while (prefix < minLen && oldLine[prefix] === newLine[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLine[oldLine.length - 1 - suffix] === newLine[newLine.length - 1 - suffix]
  ) {
    suffix++;
  }
  const oldMid = oldLine.slice(prefix, oldLine.length - suffix);
  const newMid = newLine.slice(prefix, newLine.length - suffix);
  const oldFormatted = oldMid
    ? oldLine.slice(0, prefix) + c.delWord(oldMid) + oldLine.slice(oldLine.length - suffix)
    : oldLine;
  const newFormatted = newMid
    ? newLine.slice(0, prefix) + c.addWord(newMid) + newLine.slice(newLine.length - suffix)
    : newLine;
  return { oldFormatted, newFormatted };
}

/**
 * Renders a git-delta style inline diff block anchored along the Clack `│` rail.
 * @param {string|null} beforeText
 * @param {string|null} afterText
 * @param {string} filePath
 * @param {{color?: boolean, maxLines?: number}} [opts]
 */
export function renderDeltaDiff(beforeText, afterText, filePath, opts = {}) {
  const c = createPalette(opts);
  const maxLines = opts.maxLines ?? 14;
  const a = beforeText == null ? [] : String(beforeText).replace(/\r\n/g, '\n').split('\n');
  const b = afterText == null ? [] : String(afterText).replace(/\r\n/g, '\n').split('\n');
  if (a.length && a[a.length - 1] === '') a.pop();
  if (b.length && b[b.length - 1] === '') b.pop();

  const header = `${c.rail('│')}  ${c.muted(`── git-delta preview: ${filePath} ──────────────────────────────────`)}`;
  const rows = [header];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }

  if (start > endA && start > endB) {
    rows.push(`${c.rail('│')}  ${c.muted('  (no textual differences)')}`);
    return rows.join('\n');
  }

  const ctxStart = Math.max(0, start - 1);
  for (let i = ctxStart; i < start; i++) {
    rows.push(`${c.rail('│')}  ${c.muted(String(i + 1).padStart(3, ' ') + ' │ ' + a[i])}`);
  }

  const delSlice = a.slice(start, endA + 1);
  const addSlice = b.slice(start, endB + 1);

  if (delSlice.length === 1 && addSlice.length === 1) {
    const { oldFormatted, newFormatted } = highlightWordPair(delSlice[0], addSlice[0], c);
    rows.push(`${c.rail('│')}  ${c.delLine(`${String(start + 1).padStart(3, ' ')} - ${oldFormatted}`)}`);
    rows.push(`${c.rail('│')}  ${c.addLine(`${String(start + 1).padStart(3, ' ')} + ${newFormatted}`)}`);
  } else {
    for (let i = 0; i < delSlice.length && rows.length <= maxLines; i++) {
      rows.push(`${c.rail('│')}  ${c.delLine(`${String(start + i + 1).padStart(3, ' ')} - ${delSlice[i]}`)}`);
    }
    for (let i = 0; i < addSlice.length && rows.length <= maxLines; i++) {
      rows.push(`${c.rail('│')}  ${c.addLine(`${String(start + i + 1).padStart(3, ' ')} + ${addSlice[i]}`)}`);
    }
  }

  const nextIdx = endB + 1;
  if (nextIdx < b.length && rows.length <= maxLines + 1) {
    rows.push(`${c.rail('│')}  ${c.muted(String(nextIdx + 1).padStart(3, ' ') + ' │ ' + b[nextIdx])}`);
  }

  return rows.join('\n');
}

/**
 * Counts added and deleted lines between two base64 blobs.
 * @param {string|null} base64Before
 * @param {string|null} base64After
 */
function lineStats(base64Before, base64After) {
  const dec = (/** @type {string|null} */ b) => (b == null ? '' : Buffer.from(b, 'base64').toString('utf8'));
  const beforeLines = dec(base64Before).split('\n').filter(Boolean);
  const afterLines = dec(base64After).split('\n').filter(Boolean);
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  let added = 0;
  let removed = 0;
  for (const l of afterLines) if (!beforeSet.has(l)) added++;
  for (const l of beforeLines) if (!afterSet.has(l)) removed++;
  return { added, removed, beforeText: dec(base64Before), afterText: dec(base64After) };
}

/**
 * Extracts checkpoints and changed files for a session from the shadow repository.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {string} [sessionArg]
 */
export function listSessionCheckpoints(store, sessionArg) {
  const session = sessionArg || store.listSessions()[0];
  if (!session) return { session: null, baseline: null, checkpoints: [], files: [] };
  const events = store.readSession(session);
  const first = events.find((e) => e.kind === 'turn_start' && e.checkpoint);
  const lastEnd = [...events].reverse().find((e) => e.kind === 'turn_end' && e.checkpoint);
  if (!first?.checkpoint) return { session, baseline: null, checkpoints: [], files: [] };

  const targetCommit = lastEnd?.checkpoint || first.checkpoint;
  let patchEntries = [];
  try {
    patchEntries = checkpointPatch(store, first.checkpoint, targetCommit);
  } catch {
    patchEntries = [];
  }

  const files = patchEntries.map((entry) => {
    const stats = lineStats(entry.base, entry.incoming);
    const status = entry.base == null ? 'A' : entry.incoming == null ? 'D' : 'M';
    return {
      path: entry.path,
      status,
      added: stats.added,
      removed: stats.removed,
      base: entry.base,
      incoming: entry.incoming,
      beforeText: stats.beforeText,
      afterText: stats.afterText,
    };
  });

  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);

  /** @type {{id: string, commit: string, kind: 'green'|'warn'|'gate'|'baseline', badge: string, detail: string, t: number|string|null, fileCount: number, added: number, removed: number}[]} */
  const checkpoints = [];
  const seenCommits = new Set();

  for (const ev of [...events].reverse()) {
    if (ev.kind === 'turn_end' && ev.checkpoint && !seenCommits.has(ev.checkpoint)) {
      seenCommits.add(ev.checkpoint);
      const isGreen = ev.v >= 2 && ev.verdict === 'verified' && ev.green;
      const isBlocked = Boolean(ev.blocked);
      checkpoints.push({
        id: `turn-${ev.turn || 1}-end`,
        commit: ev.checkpoint,
        kind: isGreen ? 'green' : isBlocked ? 'gate' : 'warn',
        badge: isGreen ? '★ last green' : isBlocked ? '■ gate retry' : '● turn end',
        detail: isGreen ? 'verified checks pass' : isBlocked ? 'false done blocked' : `${files.length} files`,
        t: ev.t || null,
        fileCount: files.length,
        added: totalAdded,
        removed: totalRemoved,
      });
    } else if (ev.kind === 'tool_result' && ev.beforeCheckpoint && !seenCommits.has(ev.beforeCheckpoint) && (ev.ok === false || ev.command)) {
      seenCommits.add(ev.beforeCheckpoint);
      checkpoints.push({
        id: `before-tool-${ev.turn || 1}`,
        commit: ev.beforeCheckpoint,
        kind: 'warn',
        badge: '▲ pre-command',
        detail: ev.command ? `before \`${String(ev.command).slice(0, 28)}\`` : 'pre-tool snapshot',
        t: ev.t || null,
        fileCount: files.length,
        added: totalAdded,
        removed: totalRemoved,
      });
    }
  }

  if (!seenCommits.has(first.checkpoint)) {
    checkpoints.push({
      id: `turn-${first.turn || 1}-start`,
      commit: first.checkpoint,
      kind: 'baseline',
      badge: '◌ baseline',
      detail: 'clean task baseline',
      t: first.t || null,
      fileCount: 0,
      added: 0,
      removed: 0,
    });
  }

  return { session, baseline: first.checkpoint, checkpoints, files };
}

/**
 * Selective file cherry-pick revert using Keel's transaction engine.
 * When `opts.files` is provided, only those paths are reverted; otherwise
 * delegates to `sessionRevert`.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {string} [sessionArg]
 * @param {{files?: string[], dryRun?: boolean}} [opts]
 */
export function cherryPickRevert(store, sessionArg, opts = {}) {
  const session = sessionArg || store.listSessions()[0];
  if (!session) throw new Error('Keel has no checkpoints for this project yet.');
  if (!opts.files || !opts.files.length) {
    return sessionRevert(store, session, { dryRun: opts.dryRun });
  }
  const events = store.readSession(session);
  const first = events.find((e) => e.kind === 'turn_start' && e.checkpoint);
  const last = [...events].reverse().find((e) => e.kind === 'turn_end' && e.checkpoint);
  if (!first?.checkpoint || !last?.checkpoint) {
    throw new Error('Session ownership is ambiguous. No automatic restore; review checkpoint differences in the Keel store.');
  }
  const wanted = new Set(opts.files.map((f) => f.replace(/\\/g, '/')));
  const aggregate = checkpointPatch(store, first.checkpoint, last.checkpoint).filter((e) => wanted.has(e.path));
  if (!aggregate.length) {
    throw new Error(`None of the requested files (${opts.files.join(', ')}) were modified in session ${session}.`);
  }
  return transact(
    store,
    session,
    aggregate.map((e) => ({ path: e.path, base: e.incoming, incoming: e.base })),
    { dryRun: opts.dryRun, kind: 'revert' },
  );
}

/**
 * Renders the `@clack/prompts` tree-rail interactive revert screen.
 * @param {{
 *   projectName: string,
 *   size: string,
 *   fraction: number,
 *   used: number,
 *   budget: number,
 *   checkpoints: ReturnType<typeof listSessionCheckpoints>['checkpoints'],
 *   files: ReturnType<typeof listSessionCheckpoints>['files'],
 *   selectedCpIndex?: number,
 *   selectedFiles?: boolean[],
 *   focusedFileIndex?: number,
 * }} model
 * @param {{color?: boolean, nowMs?: number}} [opts]
 */
export function renderClackRevertView(model, opts = {}) {
  const c = createPalette(opts);
  const cpIdx = model.selectedCpIndex ?? 0;
  const fileIdx = model.focusedFileIndex ?? 0;
  const checked = model.selectedFiles || model.files.map(() => true);
  const selectedCount = checked.filter(Boolean).length;
  const pct = Math.round((model.fraction || 0) * 100);

  const lines = [
    `${c.rail('┌')}  ${c.pill('keel revert')} ${c.muted(model.projectName)}`,
    `${c.rail('│')}`,
    `${c.cyan('◇')}  Task · ${c.cyan(model.size || 'feature')}  ${progressBar(model.fraction || 0, 10, c)} ${c.bright(`${pct}%`)} ${c.muted(`(${compactTokens(model.used)} / ${compactTokens(model.budget)})`)}`,
    `${c.rail('│')}`,
    `${c.cyan('◆')}  ${c.bright('Select a checkpoint to restore')}`,
  ];

  if (!model.checkpoints.length) {
    lines.push(`${c.rail('│')}  ${c.muted('No checkpoints recorded in this session yet.')}`);
  } else {
    model.checkpoints.forEach((cp, i) => {
      const active = i === cpIdx;
      const radio = active ? c.cyan('●') : c.muted('○');
      const label = active ? c.bright(cp.id.padEnd(15, ' ')) : c.muted(cp.id.padEnd(15, ' '));
      const badgeColor = cp.kind === 'green' ? c.green : cp.kind === 'gate' ? c.red : cp.kind === 'warn' ? c.amber : c.cyan;
      const age = relativeAge(cp.t, opts.nowMs);
      lines.push(`${c.cyan('│')}  ${radio} ${label} ${badgeColor(cp.badge.padEnd(13, ' '))} ${c.muted(`· ${age} · ${cp.detail}`)}`);
    });
  }

  lines.push(`${c.rail('│')}`);
  lines.push(`${c.cyan('◆')}  ${c.bright('Cherry-pick files to restore')} ${c.muted(`(Space to toggle · ${selectedCount}/${model.files.length} selected)`)}`);

  if (!model.files.length) {
    lines.push(`${c.rail('│')}  ${c.muted('No modified files in this checkpoint range.')}`);
  } else {
    model.files.forEach((f, i) => {
      const isChecked = Boolean(checked[i]);
      const isFocused = i === fileIdx;
      const box = isChecked ? c.green('◼') : c.muted('◻');
      const pointer = isFocused ? c.cyan('❯') : ' ';
      const name = isChecked ? c.bright(f.path.padEnd(22, ' ')) : c.muted(f.path.padEnd(22, ' '));
      lines.push(`${c.cyan('│')} ${pointer}${box} ${c.yellow(f.status)} ${name} ${c.green(`+${f.added}`)}  ${c.red(`-${f.removed}`)}`);
    });

    const focused = model.files[fileIdx] || model.files[0];
    if (focused) {
      lines.push(`${c.rail('│')}`);
      lines.push(renderDeltaDiff(focused.afterText, focused.beforeText, focused.path, opts));
    }
  }

  lines.push(`${c.rail('│')}`);
  lines.push(
    `${c.rail('└')}  ${c.cyan('↑/↓')} ${c.muted('move ·')} ${c.cyan('space')} ${c.muted('toggle ·')} ${c.green('enter')} ${c.bright(`restore ${selectedCount} ${selectedCount === 1 ? 'file' : 'files'}`)} ${c.muted('·')} ${c.cyan('r')} ${c.muted('last green ·')} ${c.cyan('u')} ${c.muted('undo ·')} ${c.cyan('q')} ${c.muted('quit')}`,
  );
  return lines.join('\n') + '\n';
}

/**
 * Renders the `@clack/prompts` tree-rail session overview (`keel tui` / `keel status --pretty`).
 * @param {import('./store.mjs').ProjectStore} store
 * @param {{color?: boolean, nowMs?: number}} [opts]
 */
export function renderClackStatus(store, opts = {}) {
  const c = createPalette(opts);
  const st = currentStatus(store);
  const session = store.listSessions()[0];
  const events = session ? store.readSession(session) : [];
  const start = events.find((e) => e.kind === 'session_start');
  const settings = projectSettings(loadConfig(), store.root);
  const usage = start?.transcript ? cumulativeUsage(start.agent || 'claude-code', start.transcript) : null;
  const b = budgetStatus(events, usage, settings.budgets, settings.budgetUnits);
  const sum = summarise(events);
  const plan = planning(events);

  const size = b?.size || 'feature';
  const used = b?.used || 0;
  const budget = b?.budget || settings.budgets[size] || 450000;
  const fraction = b ? b.fraction : 0;
  const pct = Math.round(fraction * 100);

  const verdictBadge = st.verdict === 'verified' ? c.green('● verified') : st.verdict === 'failed' ? c.red('■ failed') : c.amber('▲ not_verified');
  const lastGreenStr = sum.lastGreen
    ? c.green(`★ turn-${sum.lastGreen.turn || 1}-end (${relativeAge(sum.lastGreen.t, opts.nowMs)})`)
    : c.muted('none recorded yet');

  const lines = [
    `${c.rail('┌')}  ${c.pill('keel status')} ${c.muted(path.basename(store.root))} · ${verdictBadge}`,
    `${c.rail('│')}`,
    `${c.cyan('◆')}  ${c.bright('Session Budget')}`,
    `${c.rail('│')}  Task Tier   : ${c.cyan(size)} ${c.muted(`(cap: ${budget.toLocaleString('en-US')} ${settings.budgetUnits === 'weighted' ? 'units' : 'new tokens'})`)}`,
    `${c.rail('│')}  Consumed    : ${progressBar(fraction, 10, c)} ${c.bright(`${pct}%`)} ${c.muted(`(${compactTokens(used)} / ${compactTokens(budget)} · ${sum.turns} ${sum.turns === 1 ? 'turn' : 'turns'})`)}`,
    `${c.rail('│')}`,
    `${c.cyan('◆')}  ${c.bright('Plan & Verification')}`,
    `${c.rail('│')}  Plans Checked: ${c.bright(String(plan.checks))} ${c.muted(`(${plan.held} held for clarification · ${plan.unplanned} unplanned)`)}`,
    `${c.rail('│')}  Checks Run   : ${c.bright(String(sum.keelChecks.length))} ${c.muted(`(agent test runs: ${sum.agentTests.length})`)}`,
    `${c.rail('│')}`,
    `${c.cyan('◆')}  ${c.bright('Guardrails & Recovery')}`,
    `${c.rail('│')}  Last Green  : ${lastGreenStr}`,
    `${c.rail('│')}  Guard Mode  : ${c.cyan(settings.guard.mode)} ${c.muted(`· Loop radar: ${sum.loops.length} stopped`)}`,
    `${c.rail('│')}`,
    `${c.rail('└')}  Run ${c.cyan('keel revert -i')} to cherry-pick files or ${c.cyan('keel revert')} to restore the session`,
  ];
  return lines.join('\n') + '\n';
}

/**
 * Formats a hook/guard/gate event using Claude Code's native `●` / `▲` / `■` + `⎿` connector rail.
 * @param {'info'|'warn'|'error'|'pass'} level
 * @param {string} title
 * @param {string[]} [details]
 * @param {{color?: boolean}} [opts]
 */
export function renderClaudeHookNotice(level, title, details = [], opts = {}) {
  const c = createPalette(opts);
  const symbol = level === 'pass' ? c.green('●') : level === 'warn' ? c.amber('▲') : level === 'error' ? c.red('■') : c.cyan('●');
  const lines = [`${symbol} ${c.bright(title)}`];
  details.forEach((line, idx) => {
    const prefix = idx === 0 ? `  ${c.rail('⎿')}  ` : '     ';
    lines.push(`${prefix}${c.muted(line)}`);
  });
  return lines.join('\n') + '\n';
}

/**
 * Renders the 1-line bottom statusline HUD (`keel statusline`) for Claude Code / OpenCode.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {{session_id?: string, transcript_path?: string}} [info]
 * @param {{color?: boolean, nowMs?: number}} [opts]
 */
export function renderStatusline(store, info = {}, opts = {}) {
  const c = createPalette(opts);
  const session = info.session_id || store.listSessions()[0];
  const events = session ? store.readSession(session) : [];
  const start = events.find((e) => e.kind === 'session_start');
  const agent = start?.agent || 'claude-code';
  const transcript = info.transcript_path || start?.transcript || null;
  const settings = projectSettings(loadConfig(), store.root);
  const b = budgetStatus(events, cumulativeUsage(agent, transcript), settings.budgets, settings.budgetUnits);
  const sum = summarise(events);

  const sep = c.rail(' │ ');
  const brand = c.cyan('⚓ keel');
  const budgetSeg = b
    ? `${b.size} ${progressBar(b.fraction, 10, c)} ${c.bright(`${Math.round(b.fraction * 100)}%`)} ${c.muted(`(${compactTokens(b.used)}/${compactTokens(b.budget)})`)}`
    : `${c.muted('idle')} ${progressBar(0, 10, c)} ${c.muted('0%')}`;
  const greenSeg = sum.lastGreen
    ? c.green(`● last green: ${relativeAge(sum.lastGreen.t, opts.nowMs)}`)
    : c.muted('◌ no green checkpoint yet');
  const guardSeg = `${c.muted('guard:')} ${c.cyan(settings.guard.mode)}`;

  return `${brand}${sep}${budgetSeg}${sep}${greenSeg}${sep}${guardSeg}`;
}

/**
 * Runs the interactive `@clack/prompts` tree-rail checkpoint & file cherry-picker (`keel revert -i`).
 * Falls back to rendering the preview + executing when stdin is not a TTY.
 * @param {import('./store.mjs').ProjectStore} store
 * @param {string[]} [args]
 */
export async function runInteractiveRevert(store, args = []) {
  const dryRun = args.includes('--dry-run');
  const sessionIdx = args.indexOf('--session');
  const session = sessionIdx >= 0 ? args[sessionIdx + 1] : store.listSessions()[0];
  const filesIdx = args.indexOf('--files');
  const explicitFiles = filesIdx >= 0 && args[filesIdx + 1] ? args[filesIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : null;

  if (explicitFiles) {
    const res = cherryPickRevert(store, session, { files: explicitFiles, dryRun });
    return transactionText(res);
  }

  const data = listSessionCheckpoints(store, session);
  const events = data.session ? store.readSession(data.session) : [];
  const start = events.find((e) => e.kind === 'session_start');
  const settings = projectSettings(loadConfig(), store.root);
  const b = budgetStatus(events, start?.transcript ? cumulativeUsage(start.agent || 'claude-code', start.transcript) : null, settings.budgets, settings.budgetUnits);

  const state = {
    projectName: path.basename(store.root),
    size: b?.size || 'feature',
    fraction: b?.fraction || 0,
    used: b?.used || 0,
    budget: b?.budget || settings.budgets.feature || 450000,
    checkpoints: data.checkpoints,
    files: data.files,
    selectedCpIndex: 0,
    selectedFiles: data.files.map(() => true),
    focusedFileIndex: 0,
  };

  if (!process.stdin.isTTY || !process.stdout.isTTY || args.includes('--preview')) {
    return renderClackRevertView(state);
  }

  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const redraw = () => {
      process.stdout.write('\x1b[2J\x1b[H' + renderClackRevertView(state));
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const onKey = (/** @type {string} */ _str, /** @type {any} */ key) => {
      if (!key) return;
      if (key.name === 'q' || key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve('Cancelled revert.\n');
        return;
      }
      if (key.name === 'up' || key.name === 'k') {
        if (state.files.length) {
          state.focusedFileIndex = (state.focusedFileIndex - 1 + state.files.length) % state.files.length;
        }
        redraw();
      } else if (key.name === 'down' || key.name === 'j') {
        if (state.files.length) {
          state.focusedFileIndex = (state.focusedFileIndex + 1) % state.files.length;
        }
        redraw();
      } else if (key.name === 'space') {
        if (state.files.length) {
          state.selectedFiles[state.focusedFileIndex] = !state.selectedFiles[state.focusedFileIndex];
        }
        redraw();
      } else if (key.name === 'u') {
        cleanup();
        try {
          resolve(transactionText(undoTransaction(store, { dryRun })));
        } catch (err) {
          resolve(`Keel could not finish: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      } else if (key.name === 'r') {
        cleanup();
        try {
          resolve(transactionText(sessionRevert(store, data.session || undefined, { dryRun })));
        } catch (err) {
          resolve(`Keel could not finish: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        try {
          const picked = state.files.filter((_, i) => state.selectedFiles[i]).map((f) => f.path);
          const res = cherryPickRevert(store, data.session || undefined, { files: picked, dryRun });
          resolve(transactionText(res));
        } catch (err) {
          resolve(`Keel could not finish: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      }
    };

    process.stdin.on('keypress', onKey);
    redraw();
  });
}
