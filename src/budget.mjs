// Per-task token budget. A task runs from the user's prompt until the agent
// stops; agent-generated continuations count towards the same task. Warnings
// go to the user only.
//
// Usage is counted in budget units: each kind of token weighed by what it
// costs, relative to one uncached input token, as an estimate of what drains a
// plan. Raw "new tokens" (input, output and cache writes) are shown alongside.
// Configs that set their own budgets without budgetUnits keep counting in new
// tokens, so their numbers keep their meaning.

import fs from 'node:fs';
import { roundTokens } from './tokens.mjs';

/**
 * Price weights relative to one uncached input token.
 *  - anthropic: Anthropic's API prices (cache writes 1.25x, cache reads 0.1x,
 *    output 5x). Anthropic publishes no weights for subscription limits, so
 *    this is an estimate. Also used for agents and models without a published
 *    rate (Antigravity's models, OpenCode, Cursor).
 *  - openai: OpenAI's Codex rate card (October 2026): cached input 10% of
 *    input, cache writes not charged, output 6x input on every GPT-5.6 tier.
 */
/** @typedef {{input: number, cacheWrite: number, cacheRead: number, output: number}} Weights */
/** @type {Readonly<{anthropic: Weights, openai: Weights}>} */
export const WEIGHTS = Object.freeze({
  anthropic: Object.freeze({ input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 }),
  openai: Object.freeze({ input: 1, cacheWrite: 0, cacheRead: 0.1, output: 6 }),
});

/** Weights for a model or an agent's default. @param {string|null|undefined} model @param {string} [agent] */
export function weightsFor(model, agent) {
  if (/\b(gpt|codex|o\d)\b|^gpt|^o\d/i.test(String(model || ''))) return WEIGHTS.openai;
  if (!model && agent === 'codex') return WEIGHTS.openai;
  return WEIGHTS.anthropic;
}

// Budgets in budget units. Phase 3 measured new tokens on twelve real tasks;
// the same tasks came to 1.6 to 3.8 times as many budget units (more for
// longer tasks, which re-read the cached conversation more often), so the
// old new-token budgets (20k, 40k, 150k) were scaled by about 2 for small
// tasks and 3 for features.
export const DEFAULT_BUDGETS = Object.freeze({ trivial: 40000, small: 90000, feature: 450000, risky: 450000 });
/** The earlier budgets in new tokens, for configs that still count that way. */
export const NEW_TOKEN_BUDGETS = Object.freeze({ trivial: 20000, small: 40000, feature: 150000, risky: 150000 });
export const LEVELS = [0.7, 0.9, 1.0];

/**
 * @typedef {{input: number, cacheWrite: number, cacheRead: number, output: number}} Parts
 * @typedef {{units: number, newTokens: number, output: number}} Usage
 */

/** @returns {Usage} */
export function emptyUsage() {
  return { units: 0, newTokens: 0, output: 0 };
}

/** Adds one model call's tokens to a running usage. @param {Usage} total @param {Parts} p @param {Weights} w */
export function addUsage(total, p, w) {
  total.units += p.input * w.input + p.cacheWrite * w.cacheWrite + p.cacheRead * w.cacheRead + p.output * w.output;
  total.newTokens += p.input + p.cacheWrite + p.output;
  total.output += p.output;
  return total;
}

/**
 * The session's cumulative usage so far, read from the agent's transcript.
 * Other agents' adapters read their own transcripts (see their tokens()).
 * @param {'claude-code'|'codex'|string} agent
 * @param {string|null|undefined} transcriptPath
 * @returns {Usage|null}
 */
export function cumulativeUsage(agent, transcriptPath) {
  let text;
  try { text = fs.readFileSync(String(transcriptPath), 'utf8'); } catch { return null; }
  if (agent === 'codex') return codexUsage(text);
  if (agent === 'claude-code') return claudeUsage(text);
  return null;
}

/** New tokens only, as before budget units. @param {string} agent @param {string|null|undefined} transcriptPath */
export function cumulativeNewTokens(agent, transcriptPath) {
  return cumulativeUsage(agent, transcriptPath)?.newTokens ?? null;
}

/** Claude Code: each assistant message once (its usage repeats per content block); subagent sidechains are separate files. */
function claudeUsage(text) {
  const seen = new Set();
  const total = emptyUsage();
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type !== 'assistant' || e.isSidechain || !m?.usage) continue;
    const key = m.id || e.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = m.usage;
    addUsage(total, { input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 }, weightsFor(m.model, 'claude-code'));
  }
  return total;
}

/** Codex: the latest running total; its input count includes cached input, so that part is taken off. */
function codexUsage(text) {
  let last = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"token_count"')) continue;
    try {
      const e = JSON.parse(line);
      const u = e.payload?.info?.total_token_usage;
      if (u) last = u;
    } catch { /* skip */ }
  }
  const total = emptyUsage();
  if (!last) return total;
  const cached = last.cached_input_tokens || 0;
  return addUsage(total, { input: Math.max(0, (last.input_tokens || 0) - cached), cacheWrite: last.cache_write_input_tokens || 0, cacheRead: cached, output: last.output_tokens || 0 }, WEIGHTS.openai);
}

/**
 * A stored usage, which older records kept as a plain number of new tokens.
 * @param {Usage|number|null|undefined} u @returns {Usage|null}
 */
function asUsage(u) {
  if (u == null) return null;
  if (typeof u === 'number') return { units: NaN, newTokens: u, output: NaN };
  return u;
}

/**
 * The current task's usage, and the warning level it has newly crossed.
 * @param {any[]} events  The session's events.
 * @param {Usage|number|null} now  Cumulative usage now.
 * @param {Record<string, number>} budgets
 * @param {'weighted'|'new-tokens'} [unit]
 */
export function budgetStatus(events, now, budgets, unit = 'weighted') {
  const task = [...events].reverse().find((e) => e.kind === 'turn_start' && !e.continuation);
  const base = asUsage(task?.usageBase);
  const cur = asUsage(now);
  if (!task || !cur || !base || !task.size) return null;
  const budget = budgets[task.size] || (unit === 'weighted' ? DEFAULT_BUDGETS : NEW_TOKEN_BUDGETS)[task.size];
  if (!budget) return null;
  const used = Math.max(0, unit === 'weighted' ? cur.units - base.units : cur.newTokens - base.newTokens);
  if (!Number.isFinite(used)) return null;
  const fraction = used / budget;
  const warned = events.filter((e) => e.kind === 'budget' && e.turn === task.turn).map((e) => e.level);
  const crossed = LEVELS.filter((l) => fraction >= l && !warned.includes(l));
  return {
    turn: task.turn, size: task.size, used, budget, fraction, crossed, unit,
    newTokens: Math.max(0, cur.newTokens - base.newTokens),
    output: Number.isFinite(cur.output - base.output) ? Math.max(0, cur.output - base.output) : null,
    level: crossed.length ? crossed[crossed.length - 1] : null,
  };
}

/** "21,000 new tokens, 3,000 of them output", for the weighted unit. @param {{newTokens?: number, output?: number|null}} s */
function rawTokens(s) {
  if (s.newTokens == null) return '';
  return s.output != null ? `${roundTokens(s.newTokens)} new tokens, ${roundTokens(s.output)} of them output` : `${roundTokens(s.newTokens)} new tokens`;
}

/**
 * The one-line warning shown to the user.
 * @param {{size: string, used: number, budget: number, fraction: number, unit?: string, newTokens?: number, output?: number|null}} s
 * @param {{stops?: boolean}} [opts]  stops: the budget is set to stop the agent at 100%.
 */
export function budgetWarning(s, opts = {}) {
  const pct = Math.round(s.fraction * 100);
  const over = s.fraction >= 1;
  const tail = over ? (opts.stops ? ' Keel is stopping the agent, as your budget setting asks.' : ' Claude will carry on; you can stop it at any time.') : '';
  if (s.unit !== 'weighted') return `Keel: this ${s.size} task has used about ${roundTokens(s.used)} of its ${roundTokens(s.budget)} new-token budget (${pct}%).${tail}`;
  return `Keel: this ${s.size} task has used about ${pct}% of its budget (${roundTokens(s.used)} of ${roundTokens(s.budget)} units; ${rawTokens(s)}).${tail}`;
}

/** The meter line. @param {{size: string, used: number, budget: number, fraction: number, unit?: string, newTokens?: number}|null} s */
export function meterLine(s) {
  if (!s) return 'Keel: no task yet';
  if (s.unit !== 'weighted') return `Keel: ${s.size} task, about ${roundTokens(s.used)} of ${roundTokens(s.budget)} new tokens (${Math.round(s.fraction * 100)}%)`;
  return `Keel: ${s.size} task, ${Math.round(s.fraction * 100)}% of budget (${roundTokens(s.used)} of ${roundTokens(s.budget)} units, ${roundTokens(s.newTokens ?? 0)} new tokens)`;
}
