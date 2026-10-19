// Cursor adapter: Cursor's hooks (~/.cursor/hooks.json) to Keel's events, and
// Keel's decisions back to Cursor's output.
//
// Built from Cursor's hooks documentation (cursor.com/docs/agent/hooks); not
// yet checked against a recorded Cursor session. What matters here:
// - Permission hooks (beforeShellExecution, beforeReadFile, preToolUse) must
//   always print valid JSON: empty or invalid output blocks the action. So
//   Keel answers {"permission":"allow"} whenever it has nothing to say or fails.
// - "ask" is honoured by beforeShellExecution only; elsewhere Keel refuses and
//   tells the agent to ask the user.
// - beforeSubmitPrompt cannot add text, so guidance waits for the first tool
//   result (postToolUse accepts additional_context).
// - stop has no final message; afterAgentResponse carries it, and stop's
//   followup_message sends the agent back.
// - Cursor shows hook messages to the user only alongside a refusal, so
//   notices such as budget warnings go to the receipt instead.

import { makeEvent } from '../events.mjs';
import { toolKind, canonicalInput, emptyResult, shellResult, editResult, failure, exitCodeIn, parseJson, asFollowUp } from './common.mjs';

export const AGENT = 'cursor';

/** @type {import('../agents.mjs').Caps} */
export const CAPS = Object.freeze({ name: AGENT, batchHook: false, ask: true, planTool: false, promptContext: false, userNotice: false });

export const HALT_EVENTS = new Set();

const TOOLS = {
  shell: ['shell', 'bash', 'terminal', 'run_terminal_cmd', 'run_terminal_command'],
  read: ['read', 'read_file', 'readfile'],
  edit: ['write', 'edit', 'strreplace', 'str_replace', 'search_replace', 'multiedit', 'edit_file', 'write_file', 'delete', 'delete_file', 'apply_patch'],
};

const PERMISSION_EVENTS = new Set(['beforeShellExecution', 'beforeReadFile', 'preToolUse']);

/** @param {any} p @returns {import('../shim.mjs').HookInfo} */
export function info(p) {
  const event = p.hook_event_name;
  let toolInput = null;
  if (event === 'beforeShellExecution') toolInput = { command: p.command };
  else if (event === 'beforeReadFile') toolInput = { file_path: p.file_path };
  else if (event === 'preToolUse') toolInput = canonicalInput(toolKind(p.tool_name, TOOLS), p.tool_input);
  const roots = Array.isArray(p.workspace_roots) ? p.workspace_roots : [];
  return {
    prompt: typeof p.prompt === 'string' ? p.prompt : null,
    toolInput,
    lastMessage: event === 'afterAgentResponse' && typeof p.text === 'string' ? p.text : null,
    transcriptPath: p.transcript_path || process.env.CURSOR_TRANSCRIPT_PATH || null,
    projectDir: process.env.CURSOR_PROJECT_DIR || roots[0] || null,
    cwd: p.cwd || roots[0] || null,
  };
}

/** @param {any} p @param {string} root */
export function toEvent(p, root) {
  const ctx = { agent: AGENT, session: String(p.conversation_id || p.session_id || 'unknown'), turn: p.generation_id || null };
  switch (p.hook_event_name) {
    case 'sessionStart':
      return makeEvent('session_start', ctx, { source: 'startup', root, transcript: p.transcript_path || null });
    case 'beforeSubmitPrompt':
      return makeEvent('turn_start', ctx, { promptChars: String(p.prompt || '').length });
    case 'beforeShellExecution':
      return makeEvent('tool_call', ctx, { tool: 'Bash', toolUseId: p.tool_use_id || null });
    case 'beforeReadFile':
      return makeEvent('tool_call', ctx, { tool: 'Read' });
    case 'preToolUse': {
      // Shell commands and reads have their own hooks above; preToolUse covers edits.
      const kind = toolKind(p.tool_name, TOOLS);
      return kind === 'Edit' ? makeEvent('tool_call', ctx, { tool: kind, toolUseId: p.tool_use_id || null }) : null;
    }
    case 'postToolUse':
    case 'postToolUseFailure':
      return makeEvent('tool_result', ctx, toolResult(p, root));
    case 'afterAgentResponse':
      return makeEvent('agent_message', ctx, {});
    case 'stop':
      return makeEvent('turn_end', ctx, { stopHookActive: Number(p.loop_count || 0) > 0, planMode: false });
    case 'sessionEnd':
      return makeEvent('session_end', ctx, { reason: p.reason || null });
    default:
      return null;
  }
}

/** @param {any} p @param {string} root */
function toolResult(p, root) {
  const kind = toolKind(p.tool_name, TOOLS);
  const failed = p.hook_event_name === 'postToolUseFailure';
  const r = emptyResult(kind || String(p.tool_name || 'unknown'), p.tool_use_id || null);
  const input = canonicalInput(kind, p.tool_input);
  if (kind === 'Bash' && input.command) {
    const out = p.tool_output;
    const parsed = typeof out === 'string' ? parseJson(out) : out;
    const text = failed ? String(p.error_message || '') : typeof out === 'string' ? out : JSON.stringify(out ?? '');
    const code = typeof parsed?.exitCode === 'number' ? parsed.exitCode : typeof parsed?.exit_code === 'number' ? parsed.exit_code : exitCodeIn(text);
    return shellResult(r, input.command, { ok: !failed && (code == null || code === 0), exitCode: code ?? (failed ? 1 : null), errorText: text });
  }
  if (failed) return failure(r, r.tool, String(p.error_message || 'failed'));
  if (kind === 'Edit') return editResult(r, root, input.file_path || null);
  return r;
}

/**
 * @param {import('../handlers.mjs').Decision} decision
 * @param {string} hookEvent
 */
export function render(decision, hookEvent) {
  const type = decision?.type;
  if (PERMISSION_EVENTS.has(hookEvent)) {
    if (type === 'ask' && hookEvent === 'beforeShellExecution') return { permission: 'ask', user_message: decision?.reason, agent_message: decision?.reason };
    if (type === 'ask') {
      const reason = `${decision?.reason} Keel cannot ask from here, so stop and ask the user whether they want to make this change themselves.`;
      return { permission: 'deny', user_message: reason, agent_message: reason };
    }
    if (type === 'deny') return { permission: 'deny', user_message: decision?.reason, agent_message: decision?.reason };
    return { permission: 'allow' };
  }
  if (hookEvent === 'postToolUse' || hookEvent === 'postToolUseFailure') {
    if (type === 'context') return { additional_context: decision?.text };
    if (type === 'halt') return { additional_context: decision?.agentNote || decision?.message };
    return null;
  }
  if (hookEvent === 'stop' && type === 'block' && decision?.reason) return { followup_message: asFollowUp(decision.reason) };
  return null;
}

/** Output when Keel has nothing to say or fails: permission hooks need an explicit allow. @param {string} hookEvent */
export function fallback(hookEvent) {
  return PERMISSION_EVENTS.has(hookEvent) ? { permission: 'allow' } : null;
}

/** Cursor's plan files are not read; plans are checked from the final message. */
export function plansDir() {
  return null;
}
