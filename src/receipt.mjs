// Plain-English session receipt, built only from the session's stored events.

import { roundTokens } from './tokens.mjs';
import { DEFAULT_BUDGETS, NEW_TOKEN_BUDGETS } from './budget.mjs';
import { learnSummary } from './learn.mjs';
import { renameFor } from './agents.mjs';

/** @param {any[]} events  One session's events. */
export function summarise(events) {
  const turns = events.filter((e) => e.kind === 'turn_start').length;
  const ends = events.filter((e) => e.kind === 'turn_end');
  const blocked = ends.filter((e) => e.blocked);
  const unresolved = ends.filter((e) => !e.blocked && e.findings?.length);
  const loops = events.filter((e) => e.kind === 'loop');
  const tools = events.filter((e) => e.kind === 'tool_result' && !e.pending);
  const agentTests = tools.filter((e) => e.isTest);
  const keelChecks = ends.flatMap((e) => e.keelChecks || []);
  const greens = ends.filter((e) => e.green && e.checkpoint);
  const loopTokens = loops.reduce((n, e) => n + (e.tokens?.total || 0), 0);
  const start = events[0]?.t ? new Date(events[0].t) : null;
  return { turns, blocked, unresolved, loops, agentTests, keelChecks, lastGreen: greens[greens.length - 1] || null, loopTokens, start };
}

/**
 * Phase 2 numbers: how prompts were sized, which got clarity questions, and
 * what the plan check did. These are the G1 and G2 metrics in Keel's plan.
 * @param {any[]} events
 */
export function planning(events) {
  const starts = events.filter((e) => e.kind === 'turn_start' && e.size && !e.continuation);
  const sizes = { trivial: 0, small: 0, feature: 0, risky: 0 };
  for (const e of starts) sizes[e.size] = (sizes[e.size] || 0) + 1;
  const unclear = starts.filter((e) => e.clarity?.asked).length;
  const checks = events.filter((e) => e.kind === 'plan_check');
  const held = checks.filter((e) => e.held);
  const questions = held.reduce((n, e) => n + (e.questions || 0), 0);
  const gapCounts = {};
  for (const e of held) for (const g of e.gaps || []) gapCounts[g] = (gapCounts[g] || 0) + 1;
  const asked = events.filter((e) => e.kind === 'tool_result' && e.tool === 'AskUserQuestion' && e.ok).length;
  const checkedTurns = new Set(checks.map((e) => e.turn));
  const unplanned = starts.filter((s) => (s.size === 'feature' || s.size === 'risky') && !checkedTurns.has(s.turn)
    && events.some((e) => e.kind === 'turn_end' && e.turn === s.turn && e.changedFiles > 0)).length;
  return { sized: starts.length, sizes, unclear, checks: checks.length, held: held.length, questions, gapCounts, asked, unplanned };
}

const GAP_WORDS = {
  'no-test': 'no test step',
  'no-error-handling': 'no failure handling',
  'out-of-scope': 'files you did not mention',
  assumption: 'a guess',
  'no-rollback': 'no way to undo',
  'too-big': 'too big',
};

/**
 * Each task's use: from its start to the next task's start (or the session
 * total now, for the last task), in the budget's unit, with new tokens.
 * @param {any[]} events
 * @param {import('./budget.mjs').Usage|number|null|undefined} finalUsage
 * @param {Record<string, number>} [budgets]
 * @param {'weighted'|'new-tokens'} [unit]
 */
export function taskUsage(events, finalUsage, budgets, unit = 'weighted') {
  const starts = events.filter((e) => e.kind === 'turn_start' && !e.continuation && e.usageBase != null && e.size);
  const fallback = unit === 'weighted' ? DEFAULT_BUDGETS : NEW_TOKEN_BUDGETS;
  const out = [];
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].usageBase : finalUsage;
    const lastWarning = events.filter((e) => e.kind === 'budget' && e.turn === s.turn).pop();
    const a = typeof s.usageBase === 'number' ? { units: NaN, newTokens: s.usageBase } : s.usageBase;
    const b = end == null ? null : typeof end === 'number' ? { units: NaN, newTokens: end } : end;
    const measured = b ? (unit === 'weighted' ? b.units - a.units : b.newTokens - a.newTokens) : NaN;
    const used = Number.isFinite(measured) ? measured : lastWarning?.used;
    if (used == null) return;
    const newTokens = b && Number.isFinite(b.newTokens - a.newTokens) ? Math.max(0, b.newTokens - a.newTokens) : lastWarning?.newTokens ?? null;
    out.push({ n: s.n, size: s.size, used: Math.max(0, used), newTokens, budget: lastWarning?.budget || (budgets || fallback)[s.size] || fallback[s.size] });
  });
  return out;
}

/** Number of things Keel caught, for the next-session notice. @param {any[]} events */
export function catches(events) {
  const s = summarise(events);
  return { claims: s.blocked.length, loops: s.loops.length };
}

/**
 * @param {any[]} events
 * @param {{storeDir: string|null, finalTokens?: import('./budget.mjs').Usage|number|null, budgets?: Record<string, number>, budgetUnits?: 'weighted'|'new-tokens', sandbox?: string|null}} where
 *   Pass storeDir null to leave out the "where records live" line. finalTokens is the session's usage now, for the last task.
 */
export function renderReceipt(events, where) {
  const s = summarise(events);
  const lines = [];
  const when = s.start ? `${time(s.start)} on ${day(s.start)}` : 'an unknown time';
  lines.push(`Keel receipt for the session that started at ${when} (${s.turns} ${s.turns === 1 ? 'prompt' : 'prompts'}).`);
  lines.push('');

  if (!s.blocked.length && !s.unresolved.length && !s.loops.length) {
    lines.push('Keel did not need to step in. Every claim it could check matched the evidence, and no loops were found.');
  }

  if (s.blocked.length) {
    const n = s.blocked.reduce((k, e) => k + e.findings.length, 0);
    lines.push(`Keel stopped Claude from finishing ${s.blocked.length} ${s.blocked.length === 1 ? 'time' : 'times'} because ${n === 1 ? 'a claim had' : `${n} claims had`} no evidence:`);
    for (const e of s.blocked) for (const f of e.findings) lines.push(`  - ${f.summary}`);
  }
  if (s.unresolved.length) {
    lines.push('After Keel asked for evidence, these problems were still open when Claude finished:');
    for (const e of s.unresolved) for (const f of e.findings) lines.push(`  - ${f.summary}`);
  }
  if (s.loops.length) {
    lines.push(`Keel stopped ${s.loops.length} ${s.loops.length === 1 ? 'loop' : 'loops'}${s.loopTokens ? `, which had used about ${roundTokens(s.loopTokens)} tokens (most of that is the conversation, which Claude re-reads on every attempt)` : ''}:`);
    for (const e of s.loops) lines.push(`  - ${loopSentence(e.loop)}`);
  }

  const p = planning(events);
  if (p.sized) {
    lines.push('');
    const light = p.sizes.trivial + p.sizes.small;
    const parts = [`${light} trivial or small (no planning and no extra tokens)`];
    if (p.sizes.feature) parts.push(`${p.sizes.feature} ${p.sizes.feature === 1 ? 'feature' : 'features'}`);
    if (p.sizes.risky) parts.push(`${p.sizes.risky} risky`);
    lines.push(`Keel sized ${p.sized} ${p.sized === 1 ? 'prompt' : 'prompts'}: ${parts.join(', ')}.`);
    if (p.unclear) lines.push(`${p.unclear} ${p.unclear === 1 ? 'prompt looked' : 'prompts looked'} unclear, so Claude was asked to check with you before starting.`);
    if (p.checks) {
      const gaps = Object.entries(p.gapCounts).map(([k, n]) => `${GAP_WORDS[k] || k}${n > 1 ? ` (${n})` : ''}`).join(', ');
      lines.push(p.held
        ? `Keel checked ${p.checks} ${p.checks === 1 ? 'plan' : 'plans'} and held ${p.held} for ${p.questions} ${p.questions === 1 ? 'question' : 'questions'} before approval (gaps found: ${gaps}).`
        : `Keel checked ${p.checks} ${p.checks === 1 ? 'plan' : 'plans'} and found no gaps.`);
    }
    if (p.asked) lines.push(`Claude asked you questions ${p.asked} ${p.asked === 1 ? 'time' : 'times'}.`);
    if (p.unplanned) lines.push(`${p.unplanned} feature-sized ${p.unplanned === 1 ? 'prompt was' : 'prompts were'} built without a plan being shown first.`);
  }

  const learned = learnSummary(events.filter((e) => e.kind === 'learn'));
  if (learned) {
    lines.push('');
    lines.push(learned);
  }

  const guard = events.filter((e) => e.kind === 'guard');
  if (guard.length) {
    const refused = guard.filter((e) => e.decision === 'refuse');
    const asked = guard.filter((e) => e.decision !== 'refuse');
    lines.push('');
    const parts = [];
    if (refused.length) parts.push(`refused ${refused.length} dangerous ${refused.length === 1 ? 'command' : 'commands'}`);
    if (asked.length) parts.push(`asked you first about ${asked.length}`);
    lines.push(`Keel ${parts.join(' and ')}:`);
    for (const e of guard.slice(0, 6)) lines.push(`  - ${e.decision === 'refuse' ? 'Refused' : 'Asked about'}: ${e.excerpt}`);
    if (guard.length > 6) lines.push(`  - and ${guard.length - 6} more.`);
  }
  if (where.sandbox) {
    lines.push('');
    lines.push(where.sandbox);
  }

  const unit = where.budgetUnits || 'weighted';
  const tasks = taskUsage(events, where.finalTokens, where.budgets, unit);
  if (tasks.length) {
    lines.push('');
    if (unit === 'weighted') {
      lines.push('Budget use per task (budget units weigh output and cache use by price, as an estimate):');
      for (const t of tasks.slice(-5)) lines.push(`  - Prompt ${t.n} (${t.size}): ${Math.round((t.used / t.budget) * 100)}% (${roundTokens(t.used)} of ${roundTokens(t.budget)} units${t.newTokens != null ? `; ${roundTokens(t.newTokens)} new tokens` : ''}).`);
    } else {
      lines.push('Token use per task (new tokens, leaving out cache re-reads):');
      for (const t of tasks.slice(-5)) lines.push(`  - Prompt ${t.n} (${t.size}): about ${roundTokens(t.used)} of ${roundTokens(t.budget)} (${Math.round((t.used / t.budget) * 100)}%).`);
    }
    const warnings = events.filter((e) => e.kind === 'budget').length;
    if (warnings) lines.push(`Keel showed you ${warnings} budget ${warnings === 1 ? 'warning' : 'warnings'}.`);
    const stops = events.filter((e) => e.kind === 'budget_stop').length;
    if (stops) lines.push(`Keel stopped the agent at its budget ${stops} ${stops === 1 ? 'time' : 'times'}, as your budget setting asks.`);
  }

  lines.push('');
  const agentLine = s.agentTests.length
    ? `Claude ran tests ${s.agentTests.length} ${s.agentTests.length === 1 ? 'time' : 'times'}, and the last run ${s.agentTests[s.agentTests.length - 1].ok ? 'passed' : 'failed'}.`
    : 'Claude did not run any tests.';
  lines.push(agentLine);
  if (s.keelChecks.length) {
    const passed = s.keelChecks.filter((c) => c.ok).length;
    const timedOut = s.keelChecks.filter((c) => c.timedOut).length;
    lines.push(`Keel ran the project's checks ${s.keelChecks.length} ${s.keelChecks.length === 1 ? 'time' : 'times'}: ${passed} passed, ${s.keelChecks.length - passed - timedOut} failed${timedOut ? `, and ${timedOut} ran out of time` : ''}.`);
  }
  if (s.lastGreen) {
    lines.push(`The last green checkpoint was saved at ${time(new Date(s.lastGreen.t))}. Run /keel:revert to return your files to it.`);
  } else {
    lines.push('There is no green checkpoint yet, because no turn ended with passing tests.');
  }
  if (where.storeDir) {
    lines.push('');
    lines.push(`Keel keeps its records in ${where.storeDir}. Delete that folder to remove them.`);
  }
  const text = lines.join('\n') + '\n';
  // The receipt is written about Claude; other agents' sessions get their own name.
  return renameFor(text, events[0]?.agent);
}

/** @param {any} loop */
export function loopSentence(loop) {
  if (!loop) return 'A loop was stopped.';
  if (loop.kind === 'edit') return `The file ${loop.file} was edited back to the same content ${loop.count} times.`;
  const what = loop.excerpt ? `"${loop.excerpt}"` : 'the same error';
  return `The same error appeared ${loop.count} times${loop.command ? ` (from \`${loop.command}\`)` : ''}: ${what}.`;
}

/** @param {Date} d */
function time(d) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** @param {Date} d */
function day(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
