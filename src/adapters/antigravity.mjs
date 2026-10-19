// Google Antigravity adapter: agy's hooks (~/.gemini/config/hooks.json) to
// Keel's events, and Keel's decisions back to agy's output.
//
// Recorded from agy 1.4.2 on Windows (see test/fixtures/antigravity). What
// matters here, including where the documentation turned out to be wrong:
// - Payloads carry no event name, so the hook command passes it.
// - The command is split on spaces with quote marks kept, so the installer
//   launches Keel through a file URL (bin/hook-import.mjs).
// - PreToolUse must answer {"decision":"allow"} to allow: an empty answer
//   ({}) blocked every tool in a live run, and so does a crash.
// - PreInvocation fires before every model call, not once per prompt. Keel
//   starts a task only on the first call after the agent last stopped, and
//   adds its guidance as a system message step.
// - PostToolUse reports error: "" even for a failing command. The tool's
//   output and exit code ("The command exited with code 1.") are in the
//   transcript, at the same step number. A command that agy runs in the
//   background reports its result later, which Keel does not see.
// - The transcript also holds the prompt (inside <USER_REQUEST>), the final
//   reply and token counts per model call.
// - Stop with decision "continue" sends the agent back.

import fs from 'node:fs';
import { makeEvent } from '../events.mjs';
import { addUsage, emptyUsage, weightsFor } from '../budget.mjs';
import { toolKind, canonicalInput, emptyResult, shellResult, editResult, failure, exitCodeIn } from './common.mjs';

export const AGENT = 'antigravity';

/** @type {import('../agents.mjs').Caps} */
// ask is false: agy approved both ask and force_ask on its own when started with
// --dangerously-skip-permissions (seen live), so Keel pauses the command instead
// and tells the agent to ask the user, as for Codex.
export const CAPS = Object.freeze({ name: AGENT, batchHook: false, ask: false, planTool: false, promptContext: true, userNotice: false });

export const HALT_EVENTS = new Set();

const TOOLS = {
  shell: ['run_command'],
  read: ['view_file', 'read_file'],
  edit: ['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'edit_file', 'delete_file'],
};

/** The transcript's steps, oldest first. @param {string|null|undefined} file @returns {any[]} */
export function steps(file) {
  let text;
  try { text = fs.readFileSync(String(file), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn line */ }
  }
  return out;
}

/** The user's latest request. @param {any[]} list */
export function promptOf(list) {
  const input = [...list].reverse().find((s) => s.type === 'USER_INPUT' && typeof s.content === 'string');
  if (!input) return null;
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(input.content);
  return (m ? m[1] : input.content).trim() || null;
}

/** The model's latest reply text. @param {any[]} list */
export function replyOf(list) {
  const r = [...list].reverse().find((s) => s.type === 'PLANNER_RESPONSE' && typeof s.content === 'string' && s.content.trim());
  return r ? r.content.trim() : null;
}

/** @param {any} p @returns {import('../shim.mjs').HookInfo} */
export function info(p) {
  const event = p.hook_event_name;
  const call = p.toolCall || {};
  const roots = Array.isArray(p.workspacePaths) ? p.workspacePaths : [];
  const needsTranscript = event === 'PreInvocation' || event === 'Stop';
  const list = needsTranscript ? steps(p.transcriptPath) : [];
  return {
    prompt: event === 'PreInvocation' ? promptOf(list) : null,
    toolInput: event === 'PreToolUse' ? canonicalInput(toolKind(call.name, TOOLS), call.args) : null,
    lastMessage: event === 'Stop' ? replyOf(list) : null,
    transcriptPath: p.transcriptPath || null,
    projectDir: roots[0] || null,
    cwd: roots[0] || null,
  };
}

/** @param {any} p @param {string} root */
export function toEvent(p, root) {
  const ctx = { agent: AGENT, session: String(p.conversationId || 'unknown'), turn: null };
  switch (p.hook_event_name) {
    case 'SessionStart':
      return makeEvent('session_start', ctx, { source: 'startup', root, transcript: p.transcriptPath || null });
    case 'PreInvocation':
      // onlyIfNew: a model call inside a running task is not a new prompt.
      return makeEvent('turn_start', { ...ctx, turn: `t-${Date.now()}` }, { promptChars: null, onlyIfNew: true });
    case 'PreToolUse': {
      const kind = toolKind(p.toolCall?.name, TOOLS);
      return kind ? makeEvent('tool_call', ctx, { tool: kind, toolUseId: p.stepIdx != null ? 'step-' + p.stepIdx : null }) : null;
    }
    case 'PostToolUse':
      return makeEvent('tool_result', ctx, toolResult(p, root));
    case 'Stop':
      return makeEvent('turn_end', ctx, { stopHookActive: false, planMode: false });
    default:
      return null;
  }
}

/** @param {any} p @param {string} root */
function toolResult(p, root) {
  const call = p.toolCall || {};
  const kind = toolKind(call.name, TOOLS);
  const r = emptyResult(kind || String(call.name || 'unknown'), p.stepIdx != null ? `step-${p.stepIdx}` : null);
  const input = canonicalInput(kind, call.args);
  const error = typeof p.error === 'string' && p.error ? p.error : null;
  if (kind === 'Bash' && input.command) {
    if (error) return shellResult(r, input.command, { ok: false, exitCode: exitCodeIn(error) ?? 1, errorText: error });
    // The hook says nothing about the outcome, and agy writes the step to the
    // transcript only after this hook returns (measured live). The result is
    // pending until a later hook finds it (see amend).
    const outcome = p.stepIdx != null ? outcomeOf(steps(p.transcriptPath), p.stepIdx) : null;
    if (!outcome) return { ...shellResult(r, input.command, { ok: true, exitCode: null }), pending: true };
    return shellResult(r, input.command, outcome);
  }
  if (error) return failure(r, r.tool, error);
  if (kind === 'Edit') return editResult(r, root, input.file_path || null);
  return r;
}

/**
 * A shell step's outcome from the transcript, or null while it is not known:
 * the step's own "The command exited with code N", or, for a command agy ran in
 * the background, the system message that reports the task's result.
 * @param {any[]} list @param {number} index
 * @returns {{ok: boolean, exitCode: number, errorText: string}|null}
 */
export function outcomeOf(list, index) {
  const step = list.find((s) => s.step_index === index);
  let text = String(step?.content ?? '');
  const task = /background task with task id:\s*(\S+)/i.exec(text);
  if (task) {
    const done = list.find((s) => s.type === 'SYSTEM_MESSAGE' && String(s.content || '').includes(`Task id "${task[1]}" finished`));
    text = String(done?.content ?? '');
  }
  const m = /The command exited with code (\d+)/i.exec(text);
  if (!m) return null;
  const exitCode = Number(m[1]);
  return { ok: exitCode === 0, exitCode, errorText: text.replace(/^[\s\S]*?Output:\s*/, '') };
}

/**
 * Amendments for this conversation's pending shell results whose outcome is
 * now in the transcript.
 * @param {any} p @param {any[]} events
 */
export function amend(p, events) {
  const pending = events.filter((e) => e.kind === 'tool_result' && e.pending && /^step-\d+$/.test(String(e.toolUseId)));
  if (!pending.length) return [];
  const list = steps(p.transcriptPath);
  const out = [];
  for (const e of pending) {
    const outcome = outcomeOf(list, Number(String(e.toolUseId).slice(5)));
    if (!outcome) continue;
    const r = shellResult(emptyResult('Bash', e.toolUseId), String(e.command || ''), outcome);
    out.push(makeEvent('tool_result_amend', { agent: AGENT, session: e.session, turn: e.turn }, {
      amends: e.toolUseId, ok: r.ok, exitCode: r.exitCode, errorExcerpt: r.errorExcerpt, errorFingerprint: r.errorFingerprint,
    }));
  }
  return out;
}

/**
 * Usage so far in the conversation, summed over every model call. agy's input
 * count leaves out cache reads, which it records separately. Google publishes
 * no rate for agy's plans, so the default weights apply.
 * @param {string|null} transcriptPath
 */
export function tokens(transcriptPath) {
  const list = steps(transcriptPath);
  if (!list.length) return null;
  const total = emptyUsage();
  for (const s of list) {
    if (s.type !== 'PLANNER_RESPONSE') continue;
    addUsage(total, { input: s.input_tokens || 0, cacheWrite: 0, cacheRead: s.cache_read_tokens || 0, output: s.output_tokens || 0 }, weightsFor(s.model));
  }
  return total;
}

/**
 * @param {import('../handlers.mjs').Decision} decision
 * @param {string} hookEvent
 */
export function render(decision, hookEvent) {
  const type = decision?.type;
  if (hookEvent === 'PreToolUse') {
    if (type === 'deny') return { decision: 'deny', reason: decision?.reason };
    // "ask" is skipped by --dangerously-skip-permissions and by a cached
    // "always allow" (seen live: git reset --hard ran); force_ask always asks.
    if (type === 'ask') return { decision: 'force_ask', reason: decision?.reason };
    return { decision: 'allow' };
  }
  if (hookEvent === 'PreInvocation' && type === 'context' && decision?.text) {
    return { injectSteps: [{ systemMessage: { systemMessage: decision.text } }] };
  }
  if (hookEvent === 'Stop' && type === 'block' && decision?.reason) return { decision: 'continue', reason: decision.reason };
  return {};
}

/** Always valid JSON, and an explicit allow for PreToolUse, so a Keel failure never blocks a tool. @param {string} hookEvent */
export function fallback(hookEvent) {
  return hookEvent === 'PreToolUse' ? { decision: 'allow' } : {};
}

/** Antigravity's plan artifacts are not read; plans are checked from the final message. */
export function plansDir() {
  return null;
}
