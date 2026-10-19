// OpenCode adapter. OpenCode runs plugins inside its own process, so there is
// no hook payload on stdin: opencode/plugin.mjs builds a small payload for each
// plugin hook and passes it through the same shim as every other agent.
//
// Built from OpenCode's plugin API (@opencode-ai/plugin 1.17.9 types); not yet
// checked in a running OpenCode. What matters here:
// - chat.message carries the prompt; guidance is added to the system prompt
//   for that session through experimental.chat.system.transform.
// - tool.execute.before refuses a tool when the plugin throws.
// - tool.execute.after can append to the tool output the model sees, which is
//   how loop stops and late notes reach the agent.
// - session.idle is the end of a turn; a follow-up prompt sends the agent back.
// - Toasts show the user Keel's notices.

import { makeEvent } from '../events.mjs';
import { addUsage, emptyUsage, weightsFor } from '../budget.mjs';
import { toolKind, canonicalInput, emptyResult, shellResult, editResult, failure, exitCodeIn, asFollowUp } from './common.mjs';

export const AGENT = 'opencode';

/** @type {import('../agents.mjs').Caps} */
export const CAPS = Object.freeze({ name: AGENT, batchHook: false, ask: false, planTool: false, promptContext: true, userNotice: true });

export const HALT_EVENTS = new Set();

const TOOLS = {
  shell: ['bash'],
  read: ['read'],
  edit: ['write', 'edit', 'multiedit', 'patch', 'apply_patch'],
};

/** @param {any} p @returns {import('../shim.mjs').HookInfo} */
export function info(p) {
  return {
    prompt: typeof p.prompt === 'string' ? p.prompt : null,
    toolInput: p.hook_event_name === 'tool.execute.before' ? canonicalInput(toolKind(p.tool, TOOLS), p.args) : null,
    lastMessage: typeof p.lastMessage === 'string' ? p.lastMessage : null,
    transcriptPath: null,
    projectDir: p.root || null,
    cwd: p.root || null,
  };
}

/** @param {any} p @param {string} root */
export function toEvent(p, root) {
  const ctx = { agent: AGENT, session: String(p.sessionID || 'unknown'), turn: null };
  switch (p.hook_event_name) {
    case 'session.created':
      return makeEvent('session_start', ctx, { source: 'startup', root, transcript: null });
    case 'chat.message':
      return makeEvent('turn_start', { ...ctx, turn: p.messageID || `m-${Date.now()}` }, { promptChars: String(p.prompt || '').length });
    case 'tool.execute.before': {
      const kind = toolKind(p.tool, TOOLS);
      if (['task', 'agent'].includes(p.tool)) return makeEvent('tool_call', ctx, { tool: p.tool, toolUseId: p.callID || null, subagent: true });
      return kind ? makeEvent('tool_call', ctx, { tool: kind, toolUseId: p.callID || null }) : null;
    }
    case 'tool.execute.after':
      return makeEvent('tool_result', ctx, { ...toolResult(p, root), ...(['task', 'agent'].includes(p.tool) ? { subagent: true, parentSession: ctx.session, childSession: p.childSessionID || p.metadata?.sessionId || null } : {}) });
    case 'session.idle':
      return makeEvent('turn_end', ctx, { stopHookActive: false, planMode: false });
    case 'session.deleted':
      return makeEvent('session_end', ctx, { reason: 'deleted' });
    default:
      return null;
  }
}

/** @param {any} p @param {string} root */
function toolResult(p, root) {
  const kind = toolKind(p.tool, TOOLS);
  const r = emptyResult(kind || String(p.tool || 'unknown'), p.callID || null);
  const input = canonicalInput(kind, p.args);
  const output = String(p.output ?? '');
  const meta = p.metadata || {};
  if (kind === 'Bash' && input.command) {
    const code = typeof meta.exit === 'number' ? meta.exit : typeof meta.exitCode === 'number' ? meta.exitCode : exitCodeIn(output);
    return shellResult(r, input.command, { ok: code == null || code === 0, exitCode: code, errorText: output });
  }
  if (meta.error || /^error\b/i.test(output)) return failure(r, r.tool, String(meta.error || output));
  if (kind === 'Edit') return editResult(r, root, input.file_path || null);
  return r;
}

/**
 * Keel's decision as instructions for opencode/plugin.mjs:
 * {deny}, {context}, {append}, {followUp} and {toast}.
 * @param {import('../handlers.mjs').Decision} decision
 * @param {string} hookEvent
 */
export function render(decision, hookEvent) {
  if (!decision) return null;
  /** @type {Record<string, string>} */
  const out = {};
  const type = decision.type;
  if (hookEvent === 'tool.execute.before' && (type === 'deny' || type === 'ask') && decision.reason) out.deny = decision.reason;
  if (hookEvent === 'chat.message' && type === 'context' && decision.text) out.context = decision.text;
  if (hookEvent === 'tool.execute.after' && type === 'context' && decision.text) out.append = decision.text;
  if (hookEvent === 'tool.execute.after' && type === 'halt') {
    out.append = decision.agentNote || decision.message || '';
    if (decision.message) out.toast = decision.message;
  }
  if (hookEvent === 'session.idle' && type === 'block' && decision.reason) out.followUp = asFollowUp(decision.reason);
  if (type === 'notify' && decision.message) out.toast = decision.message;
  if (decision.notice) out.toast = [out.toast, decision.notice].filter(Boolean).join('\n');
  return Object.keys(out).length ? out : null;
}

/** OpenCode has no plan files that Keel reads. */
export function plansDir() {
  return null;
}

/**
 * Usage of one assistant message, weighed by the model it names (OpenCode
 * runs many providers' models). Reasoning tokens are billed as output.
 * @param {any} info  An OpenCode AssistantMessage.
 * @returns {import('../budget.mjs').Usage}
 */
export function messageTokens(info) {
  const t = info?.tokens;
  if (!t) return emptyUsage();
  return addUsage(emptyUsage(), { input: t.input || 0, cacheWrite: t.cache?.write || 0, cacheRead: t.cache?.read || 0, output: (t.output || 0) + (t.reasoning || 0) }, weightsFor(info.modelID));
}
