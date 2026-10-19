// What Keel does at each moment of a session. Handlers receive canonical
// events and return a decision; the adapter turns decisions into hook output.
// On a normal turn every handler returns null, so nothing reaches the model.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeEvent } from './events.mjs';
import { selfSpawn } from './runtime.mjs';
import { userText, isReply } from './prompttext.mjs';
import { loadConfig, projectSettings } from './store.mjs';
import { Shadow } from './checkpoint.mjs';
import { extractClaims } from './claims.mjs';
import { findTestTampering } from './testdiff.mjs';
import { evaluate, blockReason } from './gate.mjs';
import { detectLoop } from './loop.mjs';
import { detectTestCommand, detectBuildCommand, runCheck } from './checks.mjs';
import { tokensSince, roundTokens } from './tokens.mjs';
import { renderReceipt, catches } from './receipt.mjs';
import { sizeTask, clarityCheck } from './sizer.mjs';
import { checkPlan } from './plancheck.mjs';
import { turnGuidance, planHoldReason, planChecklist } from './guidance.mjs';
import { checkToolCall, askMessage, refusalMessage } from './guard/index.mjs';
import { budgetStatus, budgetWarning } from './budget.mjs';
import { sandboxStatus, sandboxLine } from './sandbox.mjs';
import { excerpt } from './redact.mjs';
import { isDebuggingPrompt, DEBUGGING_NOTE, learnNotice, learnOffSentence, learningMoment, learningRequest } from './learn.mjs';
import { keelHome } from './store.mjs';
import { renameFor } from './agents.mjs';

/**
 * @typedef {{type: 'block'|'halt'|'notify'|'context'|'deny'|'ask'|null, reason?: string, message?: string, agentNote?: string, text?: string, notice?: string} | null} Decision
 *
 * @typedef {object} HandlerContext
 * @property {import('./store.mjs').ProjectStore} store
 * @property {string|null} transcriptPath
 * @property {string|null} lastMessage   The agent's final message (Stop only).
 * @property {import('./agents.mjs').Caps} [caps]  What the agent's hooks can do.
 * @property {boolean} [haltWorks]        Whether a halt from this hook is known to stop the agent.
 * @property {string|null} [prompt]       The user's prompt (turn start only). Never stored.
 * @property {any} [toolInput]            The tool call's input (tool call only). Never stored.
 * @property {string|null} [pluginRoot]   Keel's install folder, for the plan guide path.
 * @property {string|string[]|null} [plansDir]  Where the agent may write plan files.
 * @property {() => import('./budget.mjs').Usage|null} [cumulativeTokens]  The session's usage so far.
 */

const CLAUDE_CAPS = { name: 'claude-code', batchHook: true, ask: true, planTool: true, promptContext: true, userNotice: true };

/**
 * @param {any} event  Canonical event from an adapter.
 * @param {HandlerContext} ctx
 * @returns {Decision}
 */
export function handle(event, ctx) {
  const caps = ctx.caps || CLAUDE_CAPS;
  const decision = route(event, { ...ctx, caps });
  // Remember that Keel sent the agent back, so the agent's next model call is
  // not taken for a new prompt (see onlyIfNew).
  if (event.kind === 'turn_end' && decision?.type === 'block') {
    ctx.store.append(makeEvent('sent_back', { agent: event.agent, session: event.session, turn: event.turn }));
  }
  // Budget warnings go out at the moments usage is checked: after each batch
  // of tool calls (Claude Code), before each tool call (agents without a batch
  // hook), and at the end of a turn.
  const meters = event.kind === 'turn_end' || (event.kind === 'batch_end' && caps.batchHook) || (event.kind === 'tool_call' && !caps.batchHook);
  let out = decision;
  if (meters && decision?.type !== 'halt') {
    const budget = budgetNotice(event, ctx);
    if (budget?.stop && event.kind !== 'turn_end') out = budgetStop(event, ctx.store, budget.text);
    else if (budget) out = { ...(decision || { type: null }), notice: budget.text };
  }
  return caps.name === 'claude-code' ? out : renameAgent(out, caps.name);
}

/** Keel's messages are written about Claude; other agents get their own name. */
function renameAgent(decision, agent) {
  if (!decision) return decision;
  const swap = (s) => renameFor(s, agent);
  return { ...decision, reason: swap(decision.reason), message: swap(decision.message), agentNote: swap(decision.agentNote), notice: swap(decision.notice), text: swap(decision.text) };
}

/** @param {any} event @param {HandlerContext & {caps: any}} ctx */
function route(event, ctx) {
  switch (event.kind) {
    case 'session_start': return onSessionStart(event, ctx);
    case 'turn_start': return onTurnStart(event, ctx);
    case 'tool_call': return onToolCall(event, ctx);
    case 'tool_result': return onToolResult(event, ctx);
    case 'batch_end': return onBatchEnd(event, ctx);
    case 'plan_ready': return onPlanReady(event, ctx);
    case 'turn_end': return onTurnEnd(event, ctx);
    case 'session_end': return onSessionEnd(event, ctx);
    default: return null;
  }
}

/**
 * The guard, before a tool runs. Allowed calls are not recorded. Asked or
 * refused calls are recorded with the rule and a short redacted excerpt.
 * For agents without a batch hook, a pending loop stop is delivered here by
 * refusing every tool until the user's next prompt.
 * @param {any} event @param {HandlerContext & {caps: any}} ctx
 */
function onToolCall(event, ctx) {
  const { store, caps } = ctx;
  if (!caps.batchHook) {
    let events = store.readSession(event.session);
    // An outcome that arrived late (Antigravity) may have completed a loop.
    const late = detectLoop(settled(events), projectSettings(loadConfig(), store.root).loopThreshold);
    if (late) {
      recordLoop(event, store, ctx.transcriptPath, false, late);
      events = store.readSession(event.session);
    }
    const pending = pendingLoop(events);
    if (pending?.kind === 'budget_stop') return { type: /** @type {const} */ ('deny'), reason: `Keel stopped this task at its budget, so tool calls are paused until the user's next message. Tell the user in one or two sentences what is done and what is left, and stop.` };
    if (pending) return { type: /** @type {const} */ ('deny'), reason: `Keel stopped this loop, so tool calls are paused until the user's next message. ${pending.message || ''} Tell the user in one or two sentences what kept failing, and stop.`.replace(/\s+/g, ' ').trim() };
  }
  const settings = projectSettings(loadConfig(), store.root);
  const input = ctx.toolInput || {};
  const verdict = checkToolCall(event.tool, input, { root: store.root, ...settings.guard });
  if (verdict.decision === 'allow') return null;

  let saved = false;
  if (verdict.decision === 'ask' && caps.ask && typeof input.command === 'string') {
    try {
      const shadow = new Shadow(store);
      saved = !!shadow.snapshot(event.session, `before-risky-${Date.now()}`, shadow.resolve(shadow.ref(event.session, 'latest')));
    } catch (err) {
      store.logError(err, 'checkpoint before risky command');
    }
  }
  const subject = typeof input.command === 'string' ? input.command : path.basename(String(input.file_path || input.path || ''));
  store.append(makeEvent('guard', { agent: event.agent, session: event.session, turn: event.turn }, {
    tool: event.tool,
    decision: verdict.decision,
    rules: verdict.findings.map((f) => f.rule),
    excerpt: excerpt(subject, 200),
  }));
  if (verdict.decision === 'refuse') return { type: /** @type {const} */ ('deny'), reason: refusalMessage(verdict.findings, 'refuse') };
  return caps.ask
    ? { type: /** @type {const} */ ('ask'), reason: askMessage(verdict.findings, saved) }
    : { type: /** @type {const} */ ('deny'), reason: refusalMessage(verdict.findings, 'ask') };
}

/** The latest loop or budget stop of this task, for agents that cannot halt. @param {any[]} events */
function pendingLoop(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'turn_start' && !e.continuation) return null;
    if (e.kind === 'loop' || e.kind === 'budget_stop') return e;
  }
  return null;
}

/**
 * Checks the current task's usage against its budget and returns a warning
 * for the user when a new level (70%, 90%, 100%) is crossed. stop is set when
 * 100% was crossed and the budget setting asks Keel to stop the agent there.
 * @param {any} event @param {HandlerContext} ctx
 * @returns {{text: string, stop: boolean}|null}
 */
function budgetNotice(event, ctx) {
  if (!ctx.cumulativeTokens) return null;
  const { store } = ctx;
  const events = store.readSession(event.session);
  const settings = projectSettings(loadConfig(), store.root);
  const status = budgetStatus(events, ctx.cumulativeTokens(), settings.budgets, settings.budgetUnits);
  if (!status?.level) return null;
  for (const level of status.crossed) {
    store.append(makeEvent('budget', { agent: event.agent, session: event.session, turn: status.turn }, { level, used: status.used, budget: status.budget, size: status.size, unit: status.unit, newTokens: status.newTokens }));
  }
  const stop = settings.budget?.onLimit === 'stop' && status.crossed.includes(1);
  return { text: budgetWarning(status, { stops: stop }), stop };
}

/**
 * Stops the agent once at 100% of the budget (budget.onLimit "stop"): Claude
 * Code through the batch hook, other agents by refusing further tool calls
 * until the user's next prompt.
 * @param {any} event @param {import('./store.mjs').ProjectStore} store @param {string} text
 */
function budgetStop(event, store, text) {
  const where = { agent: event.agent, session: event.session, turn: event.turn };
  store.append(makeEvent('budget_stop', where, { message: text }));
  if (event.kind === 'batch_end') {
    store.append(makeEvent('halt_delivered', where));
    return { type: /** @type {const} */ ('halt'), message: text };
  }
  return { type: /** @type {const} */ ('deny'), reason: `${text} Tell the user in one or two sentences what is done and what is left, and stop.`, notice: text };
}

/**
 * Records the session and, on a fresh start, tells the user what Keel caught
 * last time, and (once per machine) that learning notes are on.
 * @param {any} event @param {HandlerContext & {caps: any}} ctx
 */
function onSessionStart(event, { store, caps, pluginRoot }) {
  const twice = twoKeels(event, store);
  store.append(event);
  pruneInBackground(store, event.session, pluginRoot);
  if (twice) return { type: /** @type {const} */ ('notify'), message: twice };
  if (event.source === 'resume' || event.source === 'compact') return null;
  const messages = [lastSessionNotice(event, store), learnNoticeOnce(store, caps, pluginRoot)].filter(Boolean);
  return messages.length ? { type: /** @type {const} */ ('notify'), message: messages.join('\n') } : null;
}

/**
 * At most once a day per project, starts `keel prune` as a separate process
 * that the hook does not wait for, because tidying a large checkpoint store
 * can take longer than an agent lets a hook run.
 * @param {import('./store.mjs').ProjectStore} store @param {string} session @param {string|null|undefined} pluginRoot
 */
function pruneInBackground(store, session, pluginRoot) {
  if (process.env.KEEL_NO_BACKGROUND) return;
  try {
    const marker = path.join(store.dir, 'pruned-at');
    if (fs.existsSync(marker) && Date.now() - fs.statSync(marker).mtimeMs < 86400000) return;
    const self = selfSpawn(pluginRoot);
    if (!self) return;
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString());
    spawn(self.command, [...self.args, 'prune', store.root, session], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch (err) {
    store.logError(err, 'start background prune');
  }
}

/**
 * The Node.js plugin and a compiled one both installed: both run every hook,
 * so every check would run twice. The second to start says so.
 * @param {any} event @param {import('./store.mjs').ProjectStore} store
 */
function twoKeels(event, store) {
  if (!event.edition) return null;
  const other = store.readSession(event.session).find((e) => e.kind === 'session_start' && e.edition && e.edition !== event.edition);
  return other ? 'Keel: two Keel plugins are installed (the Node.js one and a compiled one), so every check runs twice. Keep one: open /plugin and uninstall the other.' : null;
}

/** @param {any} event @param {import('./store.mjs').ProjectStore} store */
function lastSessionNotice(event, store) {
  const previous = store.listSessions().find((s) => s !== event.session);
  if (!previous) return null;
  const marker = path.join(store.receiptsDir, `${previous}.announced`);
  if (fs.existsSync(marker)) return null;
  const c = catches(store.readSession(previous));
  try { fs.mkdirSync(store.receiptsDir, { recursive: true }); fs.writeFileSync(marker, ''); } catch { /* ignore */ }
  if (!c.claims && !c.loops) return null;
  const parts = [];
  if (c.claims) parts.push(`stopped ${c.claims} unproven ${c.claims === 1 ? 'claim' : 'claims'}`);
  if (c.loops) parts.push(`broke ${c.loops} ${c.loops === 1 ? 'loop' : 'loops'}`);
  return `Keel: in your last session here, Keel ${parts.join(' and ')}. Run /keel:receipt to see the details.`;
}

/**
 * The first time Keel starts a session on this machine with learning notes on,
 * it tells the user how to turn them off. A marker in Keel's home stops repeats.
 * Agents whose hooks cannot show the user a message (Codex 0.161.0 in
 * `codex exec`, Cursor, Copilot CLI) get it on the first learning note
 * instead (see offHint).
 * @param {import('./store.mjs').ProjectStore} store @param {{name: string, userNotice?: boolean}} caps @param {string|null|undefined} pluginRoot
 */
function learnNoticeOnce(store, caps, pluginRoot) {
  if (caps.userNotice === false || projectSettings(loadConfig(), store.root).learn.mode === 'off') return null;
  return markNoticeShown() ? learnNotice(caps.name, pluginRoot) : null;
}

/**
 * For agents without visible user messages: on the first learning note on this
 * machine, asks the agent to end it with one sentence telling the user how to
 * turn notes off.
 * @param {{name: string, userNotice?: boolean}} caps @param {string|null|undefined} pluginRoot
 */
function offHint(caps, pluginRoot) {
  if (caps.userNotice !== false || !markNoticeShown()) return '';
  return ` After your question, add this sentence for the user, word for word: "${learnOffSentence(pluginRoot)}"`;
}

/** Writes the one-time notice marker. Returns false when it already existed. */
function markNoticeShown() {
  const marker = path.join(keelHome(), 'learn-notice-shown');
  if (fs.existsSync(marker)) return false;
  try { fs.mkdirSync(keelHome(), { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch { return false; }
  return true;
}

/**
 * Saves a checkpoint, sizes the task and checks the prompt for vagueness.
 * Only the results are stored; the prompt text never is.
 * @param {any} event @param {HandlerContext} ctx
 */
function onTurnStart(event, { store, prompt: rawPrompt, pluginRoot, caps, cumulativeTokens }) {
  // Only what the user typed counts: blocks the agent or its extensions added are left out.
  const prompt = userText(rawPrompt);
  const settings = projectSettings(loadConfig(), store.root);
  const events = store.readSession(event.session);
  // Agents whose prompt hook fires before every model call (Antigravity's
  // PreInvocation): only the first call after the agent last stopped starts a task.
  if (event.onlyIfNew) {
    const kinds = events.map((e) => e.kind);
    const lastStart = kinds.lastIndexOf('turn_start');
    const lastEnd = kinds.lastIndexOf('turn_end');
    const running = lastStart >= 0 && (lastEnd < lastStart || kinds.slice(lastEnd).includes('sent_back'));
    if (running) return null;
  }
  const n = events.filter((e) => e.kind === 'turn_start').length + 1;
  const shadow = new Shadow(store);
  let checkpoint = null;
  try {
    checkpoint = shadow.snapshot(event.session, `turn-${n}-start`, shadow.resolve(shadow.ref(event.session, 'latest')));
  } catch (err) {
    store.logError(err, 'turn checkpoint');
  }
  // Prompts the agent generates itself (a background task finishing), slash
  // commands and short replies to the agent ("Yes") are not new requests: they
  // keep the size and scope of the user's last real prompt and get no
  // questions or guidance.
  if ((prompt != null && (prompt === '' || isSystemPrompt(prompt) || isReply(prompt))) || event.subagent) {
    const last = [...events].reverse().find((e) => e.kind === 'turn_start' && !e.continuation);
    store.append({ ...event, n, checkpoint, continuation: true, size: last?.size ?? null, scope: last?.scope ?? [] });
    return null;
  }
  // The prompt could not be read (Antigravity reads it from a transcript):
  // the task still starts, but it is not sized or questioned.
  if (prompt == null) {
    store.append({ ...event, n, checkpoint, size: 'small', promptUnknown: true, scope: [], usageBase: cumulativeTokens ? cumulativeTokens() : null });
    return null;
  }
  const sizing = sizeTask(prompt || '');
  const found = clarityCheck(prompt || '', sizing.size);
  // Plan mode asks its own questions before any work, so Keel's would be a second round.
  const clarity = event.planMode ? { ...found, ask: false } : found;
  store.append({
    ...event,
    n,
    checkpoint,
    size: sizing.size,
    sizeSignals: sizing.signals,
    override: sizing.override,
    scope: sizing.scope,
    clarity: { signs: clarity.signs, asked: clarity.ask },
    // The session's new tokens before this task, so the budget counts only this task.
    usageBase: cumulativeTokens ? cumulativeTokens() : null,
  });
  const guide = path.join(pluginRoot || '.', 'skills', 'plan', 'SKILL.md');
  const parts = [turnGuidance(sizing, clarity, guide, caps)];
  // Learning note (G5): only on debugging prompts, and never on vague ones,
  // which get clarity questions first.
  if (settings.learn.mode !== 'off' && !clarity.ask && isDebuggingPrompt(prompt, sizing.size)) {
    store.append(makeEvent('learn', { agent: event.agent, session: event.session, turn: event.turn }, { source: 'prompt', tag: 'debugging' }));
    parts.push(DEBUGGING_NOTE + offHint(caps, pluginRoot));
  }
  const text = parts.filter(Boolean).join('\n');
  if (!text) return null;
  // Agents whose prompt hook cannot add text (Cursor, Copilot CLI) get the
  // guidance with the first tool result of this prompt instead. The text holds
  // Keel's own wording and the sizer's signal words, never the prompt.
  if (caps?.promptContext === false) {
    store.append(makeEvent('guidance', { agent: event.agent, session: event.session, turn: event.turn }, { text, delivered: false }));
    return null;
  }
  return { type: /** @type {const} */ ('context'), text };
}

/**
 * Guidance waiting for this prompt's first tool result, or null. Marks it as
 * delivered so it is added only once.
 * @param {any} event @param {import('./store.mjs').ProjectStore} store @param {any[]} events
 */
function pendingGuidance(event, store, events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'turn_start' && !e.continuation) return null;
    if (e.kind === 'guidance') {
      if (e.delivered) return null;
      store.append(makeEvent('guidance', { agent: event.agent, session: event.session, turn: e.turn }, { delivered: true }));
      return e.text;
    }
  }
  return null;
}

/**
 * Plan check at approval time: Claude is about to show its plan (ExitPlanMode).
 * The first time a plan with gaps arrives in a turn, Keel holds it and asks
 * Claude to put the questions to the user; after that it lets the plan through
 * and shows the user a plain checklist next to it.
 * @param {any} event @param {HandlerContext} ctx
 */
function onPlanReady(event, ctx) {
  const { store } = ctx;
  const events = store.readSession(event.session);
  const start = turnStartFor(events, event.turn);
  const plan = latestPlanText(ctx.plansDir, start);
  if (plan == null) return null;
  const result = checkPlan(plan, { scope: start?.scope || [], size: start?.size, exists: existsIn(store.root) });
  const turnId = start?.turn ?? event.turn;
  const held = events.some((e) => e.kind === 'plan_check' && e.turn === turnId && e.held);
  const hold = result.gaps.length > 0 && !held;
  store.append(planCheckEvent(event, turnId, result, hold, 'approval'));
  if (hold) return { type: /** @type {const} */ ('deny'), reason: planHoldReason(result, 'approval') };
  return { type: /** @type {const} */ ('notify'), message: planChecklist(result) };
}

/** Records the tool result and stops the agent when it completes a loop. */
/** @param {any} event @param {HandlerContext} ctx */
function onToolResult(event, { store, transcriptPath, haltWorks = false, caps }) {
  store.append(event);
  const settings = projectSettings(loadConfig(), store.root);
  const events = store.readSession(event.session);
  const loop = detectLoop(settled(events), settings.loopThreshold);
  if (!loop) {
    const text = caps?.promptContext === false ? pendingGuidance(event, store, events) : null;
    return text ? { type: /** @type {const} */ ('context'), text } : null;
  }
  const { message, agentNote } = recordLoop(event, store, transcriptPath, haltWorks, loop);
  return { type: /** @type {const} */ ('halt'), message, agentNote };
}

/** Stores a loop stop and returns its messages for the user and the agent. */
function recordLoop(event, store, transcriptPath, haltWorks, loop) {
  const tokens = tokensSince(transcriptPath, loop.firstToolUseId);
  const message = haltMessage(event, store, loop, tokens);
  const ctx = { agent: event.agent, session: event.session, turn: event.turn };
  store.append(makeEvent('loop', ctx, { loop, tokens, message }));
  if (haltWorks) store.append(makeEvent('halt_delivered', ctx));
  const agentNote = `Keel: this is the ${ordinal(loop.count)} identical ${loop.kind === 'edit' ? 'edit' : 'failure'}, so Keel is stopping this loop for the user. Do not run any more commands or make any more edits. In one or two sentences, tell the user what keeps happening and that Keel stopped the loop.`;
  return { message, agentNote };
}

/**
 * Events with tool results whose outcome is not known yet left out, ending at
 * the newest known result, so the loop check also sees an outcome that arrived
 * late (it then fires one tool call later).
 * @param {any[]} events
 */
function settled(events) {
  const known = events.filter((e) => !(e.kind === 'tool_result' && e.pending));
  const last = known.map((e) => e.kind).lastIndexOf('tool_result');
  // A loop already reported after that result: nothing new to check.
  if (last < 0 || known.slice(last + 1).some((e) => e.kind === 'loop')) return [];
  return known.slice(0, last + 1);
}

/** Delivers a loop stop that the tool hook could not deliver itself. */
function onBatchEnd(event, { store }) {
  const events = store.readSession(event.session);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.kind === 'halt_delivered' || e.kind === 'turn_start') return null;
    if (e.kind === 'loop') {
      store.append(makeEvent('halt_delivered', { agent: event.agent, session: event.session, turn: event.turn }));
      return { type: /** @type {const} */ ('halt'), message: e.message };
    }
  }
  return null;
}

/** @param {number} n */
function ordinal(n) {
  return ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'][n] || `${n}th`;
}

/** The plain-English stop message for the user. */
function haltMessage(event, store, loop, tokens) {
  const shadow = new Shadow(store).init();
  const green = shadow.resolve(shadow.ref(event.session, 'green')) || shadow.resolve('refs/keel/green');
  const spent = tokens ? ` These attempts used about ${roundTokens(tokens.total)} tokens.` : '';
  const what = loop.kind === 'edit'
    ? `the file ${loop.file} was edited back to the same content ${loop.count} times`
    : `the same error appeared ${loop.count} times${loop.excerpt ? ` (${loop.excerpt})` : ''}`;
  const subject = loop.kind === 'edit' ? loop.file : (loop.excerpt || 'this error');
  return [
    `Keel stopped Claude because ${what}.${spent}`,
    green
      ? 'Run /keel:revert to put your files back to the last state where the tests passed.'
      : 'There is no green checkpoint yet, so /keel:revert would go back to the start of this session.',
    'Then try a prompt like this, which asks for the cause before any more edits:',
    `"Stop changing code for a moment. ${loop.kind === 'edit' ? `You keep switching ${subject} between the same versions.` : `The error "${subject}" keeps coming back.`} Read the relevant code, explain in plain words why it happens, and propose one fix. Wait for my OK before editing."`,
  ].join('\n');
}

/** The evidence gate. */
function onTurnEnd(event, ctx) {
  const { store } = ctx;
  const events = store.readSession(event.session);
  const turnStarts = events.filter((e) => e.kind === 'turn_start');
  const start = turnStarts.find((e) => e.turn && e.turn === event.turn) || turnStarts[turnStarts.length - 1] || null;
  const turnId = start?.turn ?? event.turn;
  const alreadyBlocked = events.some((e) => e.kind === 'turn_end' && e.turn === turnId && e.blocked);
  const stopHookActive = !!event.stopHookActive || alreadyBlocked;

  const startIdx = start ? events.indexOf(start) : 0;
  const turnEvents = events.slice(startIdx).filter((e) => e.kind === 'tool_result' && !e.pending);

  const shadow = new Shadow(store);
  const base = turnStarts.find((e) => e.checkpoint)?.checkpoint || null;
  let end = null;
  let turnChanges;
  let sessionChanges;
  let tampering = [];
  try {
    if (start?.checkpoint) {
      end = shadow.snapshot(event.session, `turn-${start.n}-end`, start.checkpoint);
    }
  } catch (err) {
    store.logError(err, 'end checkpoint');
  }
  if (start?.checkpoint && end) {
    turnChanges = shadow.diffNames(start.checkpoint, end);
    sessionChanges = base ? shadow.diffNames(base, end) : turnChanges;
    tampering = findTestTampering(turnChanges, (file, side) => shadow.show(side === 'before' ? start.checkpoint : end, file));
  } else {
    // No checkpoint (snapshot skipped or failed): fall back to what the tools reported.
    turnChanges = filesFrom(turnEvents);
    sessionChanges = filesFrom(events.filter((e) => e.kind === 'tool_result'));
  }

  // A plan turn (plan mode, or a feature turn that produced a plan and changed
  // nothing) gets the plan check here when no ExitPlanMode check ran, for
  // example where plan-mode tools are unavailable. The evidence gate has
  // nothing to check in such a turn.
  // Plan mode forbids project edits, so any change there comes from another
  // tool (for example a plugin writing its own state folder). Outside plan
  // mode, changes inside hidden tool folders at the root do not count.
  const planChecked = events.some((e) => e.kind === 'plan_check' && e.turn === turnId);
  const planSized = start?.size === 'feature' || start?.size === 'risky';
  const codeChanges = turnChanges.filter((c) => !/^\.[^/]+\//.test(c.path));
  if (event.planMode || (planSized && codeChanges.length === 0)) {
    if (planChecked) {
      store.append({ ...event, turn: turnId, planTurn: true, changedFiles: 0, findings: [], blocked: false, checkpoint: end });
      return null;
    }
    const fromFile = latestPlanText(ctx.plansDir, start);
    const plan = fromFile ?? (looksLikePlan(ctx.lastMessage) ? ctx.lastMessage : null);
    if (plan != null) {
      const pc = checkPlan(plan, { scope: start?.scope || [], size: start?.size, exists: existsIn(store.root) });
      const hold = pc.gaps.length > 0 && !stopHookActive;
      store.append(planCheckEvent(event, turnId, pc, hold, 'stop'));
      store.append({ ...event, turn: turnId, planTurn: true, changedFiles: 0, findings: [], blocked: false, checkpoint: end });
      return hold
        ? { type: /** @type {const} */ ('block'), reason: planHoldReason(pc, 'stop') }
        : { type: /** @type {const} */ ('notify'), message: planChecklist(pc) };
    }
  }

  const settings = projectSettings(loadConfig(), store.root);
  const claims = extractClaims(ctx.lastMessage);
  const result = evaluate({
    claims,
    turnEvents,
    turnChanges,
    sessionChanges,
    tampering,
    testCommand: detectTestCommand(store.root, settings),
    buildCommand: detectBuildCommand(store.root, settings),
    runChecks: settings.runChecks && !stopHookActive,
    run: (cmd) => runCheck(cmd, store.root, settings.checkTimeoutSec),
    caseInsensitive: process.platform === 'win32' || process.platform === 'darwin',
  });

  if (result.green && end) {
    try { shadow.markGreen(event.session, end); } catch (err) { store.logError(err, 'mark green'); }
  }
  const block = result.findings.length > 0 && !stopHookActive;
  const learn = block || stopHookActive ? null : learningCheck(event, ctx, events, start, end, shadow);
  store.append({
    ...event,
    turn: turnId,
    claims: { tests: !!claims.tests, build: !!claims.build, done: !!claims.done, files: claims.files.length },
    changedFiles: turnChanges.length,
    findings: result.findings.map((f) => ({ kind: f.kind, summary: f.summary })),
    keelChecks: result.keelChecks.map(({ command, ok, exitCode, timedOut, durationMs }) => ({ command, ok, exitCode, timedOut, durationMs })),
    green: result.green,
    checkpoint: end,
    blocked: block,
  });
  if (block) return { type: /** @type {const} */ ('block'), reason: blockReason(result.findings) };
  return learn ? { type: /** @type {const} */ ('block'), reason: learn } : null;
}

/**
 * Learning moments that appeared during a prompt that got no note at the
 * start: a new dependency, the project's first file of a new kind, or a test
 * or build that failed and then passed after edits. At most one request per
 * prompt (continuations included), and none after a loop stop.
 * @param {any} event @param {HandlerContext} ctx @param {any[]} events
 * @param {any} start  This turn's turn_start event.
 * @param {string|null} end  The end-of-turn checkpoint.
 * @param {Shadow} shadow
 * @returns {string|null}  The instruction that sends the agent back, or null.
 */
function learningCheck(event, ctx, events, start, end, shadow) {
  const { store } = ctx;
  if (projectSettings(loadConfig(), store.root).learn.mode === 'off') return null;
  const startIdx = start ? events.indexOf(start) : events.length - 1;
  const taskIdx = lastIndex(events, (e, i) => i <= startIdx && e.kind === 'turn_start' && !e.continuation);
  const task = taskIdx >= 0 ? events[taskIdx] : null;
  const since = events.slice(Math.max(0, taskIdx));
  if (since.some((e) => e.kind === 'learn' || e.kind === 'loop')) return null;
  let changes = null;
  let filesBefore = null;
  const from = task?.checkpoint || null;
  if (from && end) {
    try {
      changes = shadow.diffNames(from, end);
      filesBefore = shadow.listFiles(from);
    } catch (err) {
      store.logError(err, 'learning check');
    }
  }
  const moment = learningMoment({
    toolResults: since.filter((e) => e.kind === 'tool_result' && !e.pending),
    changes,
    filesBefore,
    read: (file, side) => (from && end ? shadow.show(side === 'before' ? from : end, file) : null),
  });
  if (!moment) return null;
  store.append(makeEvent('learn', { agent: event.agent, session: event.session, turn: task?.turn ?? event.turn }, {
    source: 'stop',
    tag: moment.tag,
    ...(moment.tag === 'dependency' ? { names: moment.names.map((n) => excerpt(n, 60)) } : {}),
    ...(moment.tag === 'new-file' ? { fileKind: moment.kind } : {}),
  }));
  return learningRequest(moment) + offHint(ctx.caps || CLAUDE_CAPS, ctx.pluginRoot);
}

/** @template T @param {T[]} list @param {(item: T, i: number) => boolean} test */
function lastIndex(list, test) {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i], i)) return i;
  return -1;
}

/** Writes the receipt. The session is ending, so it is shown next time or with /keel:receipt. */
/** @param {any} event @param {HandlerContext} ctx */
function onSessionEnd(event, { store, cumulativeTokens, transcriptPath }) {
  store.append(event);
  const { budgets, budgetUnits, guard } = projectSettings(loadConfig(), store.root);
  const sandbox = guard.mode === 'beginner' ? sandboxLine(event.agent, sandboxStatus(event.agent, { transcriptPath, root: store.root })) : null;
  store.writeReceipt(event.session, renderReceipt(store.readSession(event.session), { storeDir: store.dir, finalTokens: cumulativeTokens ? cumulativeTokens() : null, budgets, budgetUnits, sandbox }));
  return null;
}

/**
 * A prompt the user did not type as a request: an agent-generated
 * notification (such as <task-notification>) or a slash command.
 * @param {string|null|undefined} prompt
 */
function isSystemPrompt(prompt) {
  const p = String(prompt || '').trimStart();
  // "[Keel]" marks Keel's own follow-up, which agents such as Cursor, Copilot
  // CLI and OpenCode deliver as a new prompt.
  return /^<(task-notification|command-name|command-message|local-command|system-reminder|bash-(input|stdout))\b/.test(p) || /^\/[\w:-]+(\s|$)/.test(p) || /^\[Keel\]/.test(p);
}

/** The turn_start event for a turn id, else the latest one. @param {any[]} events @param {string|null} turn */
function turnStartFor(events, turn) {
  const starts = events.filter((e) => e.kind === 'turn_start');
  return starts.find((e) => e.turn && e.turn === turn) || starts[starts.length - 1] || null;
}

/**
 * The text of the newest plan file written since the turn started, in any of
 * the plan folders, read from disk when needed and never stored.
 * @param {string|string[]|null|undefined} dirs
 * @param {any} start  The turn_start event.
 */
function latestPlanText(dirs, start) {
  const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
  const since = start?.t ? Date.parse(start.t) - 2000 : 0;
  let best = null;
  for (const dir of list) {
    let names = [];
    try { names = fs.readdirSync(/** @type {string} */ (dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const file = path.join(/** @type {string} */ (dir), name);
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime >= since && (!best || mtime > best.mtime)) best = { file, mtime };
      } catch { /* removed meanwhile */ }
    }
  }
  try { return best ? fs.readFileSync(best.file, 'utf8') : null; } catch { return null; }
}

/**
 * A message laid out as a plan: a heading that names a plan, phase or step,
 * or plan wording at the start followed by at least three numbered or
 * checkbox steps. Answers with ordinary headings, tables or bullet lists are
 * not plans.
 * @param {string|null} text
 */
export function looksLikePlan(text) {
  if (!text) return false;
  if (/^#{1,4}\s*(?:\*\*)?\s*(the\s+)?(plan|phase|step)\b/im.test(text)) return true;
  const steps = (text.match(/^\s*(?:[-*]\s+\[[ xX]\]\s+|\d+[.)]\s+)\S/gm) || []).length;
  const opening = text.trimStart().slice(0, 300);
  return steps >= 3 && /\b(plan|phases?|steps?)\b/i.test(opening);
}

/** @param {string} root */
function existsIn(root) {
  return (p) => fs.existsSync(path.join(root, p));
}

/** What Keel stores about a plan check: gap kinds and counts, never the plan. */
function planCheckEvent(event, turnId, result, held, source) {
  return makeEvent('plan_check', { agent: event.agent, session: event.session, turn: turnId }, {
    source,
    gaps: result.gaps.map((g) => g.kind),
    questions: held ? result.questions.length : 0,
    held,
    phases: result.phases,
    tasks: result.tasks,
  });
}

/** @param {any[]} toolEvents */
function filesFrom(toolEvents) {
  const seen = new Set();
  for (const e of toolEvents) for (const f of e.files || []) seen.add(f);
  return [...seen].map((p) => ({ status: 'M', path: p }));
}

