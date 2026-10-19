// One summary of a project's Keel state, shared by every interface that shows
// it: the panel and band inside Claude Code (hooks/keel-ui.tsx, through
// `keel ui --json`) and the VS Code extension. It reads only Keel's own
// records, so it is cheap enough to refresh after every tool call: the
// verdict is the one last recorded, with its time, and `keel verify` gives a
// fresh one.

import path from 'node:path';
import { loadConfig, projectSettings } from './store.mjs';
import { budgetStatus, cumulativeUsage } from './budget.mjs';
import { summarise } from './receipt.mjs';
import { Shadow } from './checkpoint.mjs';

/**
 * @typedef {'verified'|'failed'|'not_verified'} Verdict
 * @typedef {{
 *   v: 1,
 *   project: { name: string, root: string },
 *   store?: { dir: string, shadow: string, base: string|null },
 *   session: string|null,
 *   prompts: number,
 *   verdict: { value: Verdict, reasons: string[], checks: {id: string, verdict: string, passed: number|null, total: number|null, failed: number|null, skipped: number|null}[], at: string|null, source: 'turn'|'verify'|null },
 *   task: { prompt: number, size: string, fraction: number, used: number, budget: number, unit: string, newTokens: number|null } | null,
 *   lastGreen: { prompt: number|null, at: string } | null,
 *   timeline: { prompt: number|null, at: string|null, kind: 'green'|'failed'|'blocked'|'done', files: number, summary: string }[],
 *   changes: { path: string, status: 'A'|'M'|'D', added: number, removed: number }[],
 *   guard: { mode: string, refused: number, asked: number, recent: { decision: 'refuse'|'ask', rule: string, what: string, at: string|null }[] },
 *   catches: { claims: number, loops: number },
 *   learn: string,
 * }} UiModel
 */

/** @param {string|null|undefined} value @returns {Verdict} */
function asVerdict(value) {
  return value === 'verified' || value === 'failed' ? value : 'not_verified';
}

/** @param {any} check */
function checkSummary(check) {
  const c = check?.counts || {};
  return {
    id: String(check?.id || 'check'),
    verdict: String(check?.verdict || 'not_verified'),
    passed: Number.isFinite(c.passed) ? c.passed : null,
    total: Number.isFinite(c.discovered) ? c.discovered : null,
    failed: Number.isFinite(c.failed) ? c.failed : null,
    skipped: Number.isFinite(c.skipped) ? c.skipped : null,
  };
}

/**
 * Files that differ between two checkpoints, with line counts, straight from
 * git (reading every file's text to count lines is far slower). A binary file
 * counts no lines.
 * @param {import('./store.mjs').ProjectStore} store @param {string} from @param {string} to
 * @returns {UiModel['changes']}
 */
export function changedFiles(store, from, to) {
  try {
    const shadow = new Shadow(store);
    const status = new Map(shadow.diffNames(from, to).map((d) => [d.path, d.status]));
    const parts = shadow.git(['diff', '--numstat', '--no-renames', '-z', from, to]).split('\0').filter(Boolean);
    return parts.map((line) => {
      const [added, removed, file] = line.split('\t');
      const s = status.get(file) || 'M';
      return { path: file, status: /** @type {'A'|'M'|'D'} */ (s === 'A' || s === 'D' ? s : 'M'), added: Number(added) || 0, removed: Number(removed) || 0 };
    }).sort((a, b) => a.path.localeCompare(b.path));
  } catch {
    return [];
  }
}

/**
 * @param {import('./store.mjs').ProjectStore} store
 * @param {{ session?: string|null, usage?: (agent: string, transcript: string|null) => any }} [opts]
 * @returns {UiModel}
 */
export function buildUiModel(store, opts = {}) {
  const settings = projectSettings(loadConfig(), store.root);
  const session = opts.session || store.listSessions()[0] || null;
  const events = session ? store.readSession(session) : [];
  const starts = events.filter((e) => e.kind === 'turn_start' && !e.continuation);
  /** @type {Map<string, number>} */
  const promptOf = new Map();
  for (const s of events.filter((e) => e.kind === 'turn_start')) {
    if (s.turn && Number.isFinite(s.n)) promptOf.set(s.turn, s.n);
  }

  // The verdict: the latest one recorded by a finished turn or by `keel verify`.
  const judged = [...events].reverse().find((e) => (e.kind === 'turn_end' && e.v >= 2 && e.verdict) || e.kind === 'verification');
  const evidence = judged?.kind === 'verification' ? judged.evidence : judged?.verification;
  const verdict = {
    value: asVerdict(judged?.kind === 'verification' ? judged.evidence?.verdict ?? judged.verdict : judged?.verdict),
    reasons: [...new Set([...(evidence?.reasons || []), ...((judged?.findings || []).map((f) => f.summary))])].filter(Boolean).slice(0, 6),
    checks: (evidence?.checks || []).map(checkSummary),
    at: judged?.t || null,
    source: /** @type {'turn'|'verify'|null} */ (judged ? (judged.kind === 'verification' ? 'verify' : 'turn') : null),
  };
  if (!judged) verdict.reasons = ['No check has run in this session yet.'];

  // The current task's budget.
  const start = events.find((e) => e.kind === 'session_start');
  const usageOf = opts.usage || ((agent, transcript) => cumulativeUsage(agent, transcript));
  let task = null;
  try {
    const usage = start?.transcript ? usageOf(start.agent || 'claude-code', start.transcript) : null;
    const b = budgetStatus(events, usage, settings.budgets, settings.budgetUnits);
    const current = starts.at(-1);
    if (b && current) {
      task = { prompt: current.n ?? starts.length, size: b.size, fraction: b.fraction, used: b.used, budget: b.budget, unit: b.unit, newTokens: b.newTokens ?? null };
    }
  } catch { task = null; }

  // The prompts' ends, newest first.
  const ends = events.filter((e) => e.kind === 'turn_end');
  const timeline = ends.slice(-8).reverse().map((e) => ({
    prompt: promptOf.get(e.turn) ?? null,
    at: e.t || null,
    kind: /** @type {'green'|'failed'|'blocked'|'done'} */ (e.green ? 'green' : e.blocked ? 'blocked' : e.verdict === 'failed' ? 'failed' : 'done'),
    files: Number(e.changedFiles) || 0,
    summary: e.green ? 'Checks passed' : e.blocked ? 'Sent back: a claim had no evidence' : e.verdict === 'failed' ? 'Checks failed' : (Number(e.changedFiles) ? `${e.changedFiles} ${e.changedFiles === 1 ? 'file' : 'files'} changed` : 'No files changed'),
  }));
  const green = [...ends].reverse().find((e) => e.green && e.checkpoint);

  // Files this session changed, from its first checkpoint to its latest.
  const first = events.find((e) => e.kind === 'turn_start' && e.checkpoint)?.checkpoint;
  const last = [...events].reverse().find((e) => e.kind === 'turn_end' && e.checkpoint)?.checkpoint;
  const changes = first && last ? changedFiles(store, first, last) : [];

  const guardEvents = events.filter((e) => e.kind === 'guard');
  const s = summarise(events);
  return {
    v: 1,
    project: { name: path.basename(store.root), root: store.root },
    // Where Keel keeps its records (the VS Code extension watches it) and the
    // checkpoint the session started from (its diffs compare against it).
    store: { dir: store.dir, shadow: store.shadowDir, base: first || null },
    session,
    prompts: starts.length,
    verdict,
    task,
    lastGreen: green ? { prompt: promptOf.get(green.turn) ?? null, at: green.t } : null,
    timeline,
    changes,
    guard: {
      mode: settings.guard?.mode || 'beginner',
      refused: guardEvents.filter((e) => e.decision === 'refuse').length,
      asked: guardEvents.filter((e) => e.decision !== 'refuse').length,
      recent: guardEvents.slice(-5).reverse().map((e) => ({ decision: e.decision === 'refuse' ? 'refuse' : 'ask', rule: (e.rules || [])[0] || 'guard', what: String(e.excerpt || ''), at: e.t || null })),
    },
    catches: { claims: s.blocked.length, loops: s.loops.length },
    learn: settings.learn?.mode === 'off' ? 'off' : 'on',
  };
}
