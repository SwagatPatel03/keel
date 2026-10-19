// GitHub Copilot CLI adapter: Copilot's command hooks (~/.copilot/hooks/keel.json)
// to Keel's events, and Keel's decisions back to Copilot's output.
//
// Built from GitHub's CLI hooks reference; not yet checked against a recorded
// Copilot CLI session. What matters here:
// - Keel registers the camelCase events, whose payloads use sessionId,
//   toolName and toolArgs (sometimes a JSON string). PascalCase events send
//   Claude-Code-style payloads; both shapes are read.
// - userPromptSubmitted cannot add text, so guidance waits for the first tool
//   result (postToolUse accepts additionalContext).
// - agentStop has no final message; it is read from the transcript, whose
//   format is not documented.
// - A crashed preToolUse hook denies the tool, so Keel always exits normally.
// - Copilot has no user-only message channel; notices go to the receipt.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEvent } from '../events.mjs';
import { addUsage, emptyUsage, weightsFor } from '../budget.mjs';
import { toolKind, canonicalInput, emptyResult, shellResult, editResult, failure, exitCodeIn, lastTranscriptText, asFollowUp, patchFiles } from './common.mjs';

export const AGENT = 'copilot';

/** @type {import('../agents.mjs').Caps} */
export const CAPS = Object.freeze({ name: AGENT, batchHook: false, ask: true, planTool: false, promptContext: false, userNotice: false });

export const HALT_EVENTS = new Set();

const TOOLS = {
  shell: ['bash', 'powershell', 'pwsh', 'shell'],
  read: ['view', 'read', 'read_file', 'cat'],
  edit: ['create', 'edit', 'str_replace', 'str_replace_editor', 'insert', 'write', 'write_file', 'apply_patch', 'delete'],
};

// PascalCase names (Claude-Code-compatible payloads) mapped onto the camelCase ones.
const EVENT_NAMES = {
  SessionStart: 'sessionStart', SessionEnd: 'sessionEnd', UserPromptSubmit: 'userPromptSubmitted',
  PreToolUse: 'preToolUse', PostToolUse: 'postToolUse', PostToolUseFailure: 'postToolUseFailure', Stop: 'agentStop',
};

/** @param {any} p */
function eventName(p) {
  return EVENT_NAMES[p.hook_event_name] || p.hook_event_name;
}

/** @param {any} p */
function toolName(p) {
  return p.toolName ?? p.tool_name;
}

/** @param {any} p */
function toolArgs(p) {
  return p.toolArgs ?? p.tool_input;
}

/**
 * Tool input in Keel's shape. apply_patch sends the patch itself as a string,
 * so its files are read from the patch (recorded from Copilot CLI 1.0.98).
 * @param {any} p
 */
function inputOf(p) {
  const kind = toolKind(toolName(p), TOOLS);
  const args = toolArgs(p);
  if (String(toolName(p)).toLowerCase() === 'apply_patch') {
    const patch = typeof args === 'string' ? args : String(args?.input ?? args?.patch ?? '');
    return { kind, input: { file_path: patchFiles(patch)[0] }, files: patchFiles(patch) };
  }
  const input = canonicalInput(kind, args);
  return { kind, input, files: input.file_path ? [input.file_path] : [] };
}

/**
 * Copilot keeps each session's events in ~/.copilot/session-state/<id>/events.jsonl;
 * only agentStop names the file, so the other hooks work it out from the session id.
 * @param {any} p
 */
function transcriptOf(p) {
  if (p.transcriptPath || p.transcript_path) return p.transcriptPath || p.transcript_path;
  const id = p.sessionId || p.session_id;
  if (!id || !/^[\w-]+$/.test(String(id))) return null;
  return path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-state', String(id), 'events.jsonl');
}

/** @param {any} p @returns {import('../shim.mjs').HookInfo} */
export function info(p) {
  const event = eventName(p);
  const transcriptPath = transcriptOf(p);
  return {
    prompt: typeof p.prompt === 'string' ? p.prompt : null,
    toolInput: event === 'preToolUse' ? inputOf(p).input : null,
    lastMessage: event === 'agentStop' ? (p.last_assistant_message ?? lastTranscriptText(transcriptPath, 'assistant')) : null,
    transcriptPath,
    cwd: p.cwd || null,
  };
}

/** @param {any} p @param {string} root */
export function toEvent(p, root) {
  const event = eventName(p);
  const ctx = { agent: AGENT, session: String(p.sessionId || p.session_id || 'unknown'), turn: null };
  // A sub-agent's hooks arrive with its tool-call id as the session id
  // ("call_..."), seen in a recorded 1.0.98 run. Its tool calls are still
  // guarded, but its prompt is the main agent's, not the user's.
  const subagent = /^call_/.test(ctx.session);
  switch (event) {
    case 'sessionStart':
      return makeEvent('session_start', ctx, { source: p.source || null, root, transcript: null });
    case 'userPromptSubmitted':
      // Copilot payloads carry no prompt id, so Keel makes one.
      return makeEvent('turn_start', { ...ctx, turn: `p-${p.timestamp || Date.now()}` }, { promptChars: String(p.prompt || '').length, ...(subagent ? { subagent: true } : {}) });
    case 'preToolUse': {
      const kind = toolKind(toolName(p), TOOLS);
      return kind ? makeEvent('tool_call', ctx, { tool: kind, toolUseId: p.toolCallId || p.tool_use_id || null }) : null;
    }
    case 'postToolUse':
    case 'postToolUseFailure':
      return makeEvent('tool_result', ctx, toolResult(p, root, event === 'postToolUseFailure'));
    case 'agentStop':
      // The main agent's stop is checked; a sub-agent's is not.
      return subagent ? null : makeEvent('turn_end', ctx, { stopHookActive: !!p.stop_hook_active, planMode: false });
    case 'sessionEnd':
      return makeEvent('session_end', ctx, { reason: p.reason || null });
    default:
      return null;
  }
}

/** @param {any} p @param {string} root @param {boolean} failed */
function toolResult(p, root, failed) {
  const { kind, input, files } = inputOf(p);
  const r = emptyResult(kind || String(toolName(p) || 'unknown'), p.toolCallId || p.tool_use_id || null);
  const result = p.toolResult ?? p.tool_result ?? p.tool_response ?? {};
  const text = failed ? String(p.error ?? '') : String(result.textResultForLlm ?? result.text_result_for_llm ?? (typeof result === 'string' ? result : ''));
  const resultType = result.resultType ?? result.result_type ?? 'unknown';
  if (kind !== 'Bash') r.ok = failed ? false : resultType === 'success' ? true : null;
  if (kind === 'Bash' && input.command) {
    const code = exitCodeIn(text);
    const ok = !failed && resultType === 'success' && (code == null || code === 0);
    return shellResult(r, input.command, { ok, exitCode: code ?? (failed ? 1 : null), errorText: text });
  }
  if (failed || resultType === 'failure') return failure(r, r.tool, text || 'failed');
  if (kind === 'Edit') {
    for (const file of files) {
      const one = editResult(emptyResult(r.tool, null), root, file);
      r.files.push(...one.files);
      r.fileHash = r.fileHash || one.fileHash;
    }
  }
  return r;
}

/**
 * Usage so far in the session, from Copilot's usage records. Their input count
 * includes cache reads and writes. New tokens (input minus cache reads, plus
 * output) matched Copilot's own session total in a recorded 1.0.98 run. Each
 * record names its model, which picks the price weights.
 * @param {string|null} transcriptPath
 */
export function tokens(transcriptPath) {
  let text;
  try { text = fs.readFileSync(String(transcriptPath), 'utf8'); } catch { return null; }
  const total = emptyUsage();
  for (const line of text.split('\n')) {
    if (!line.includes('session.usage_record')) continue;
    try {
      const u = JSON.parse(line).data?.usage;
      if (!u) continue;
      const cacheRead = u.cacheReadTokens || 0;
      const cacheWrite = u.cacheWriteTokens || 0;
      const input = Math.max(0, (u.inputTokens || 0) - cacheRead - cacheWrite);
      addUsage(total, { input, cacheWrite, cacheRead, output: u.outputTokens || 0 }, weightsFor(u.model));
    } catch { /* a torn line */ }
  }
  return total;
}

/**
 * @param {import('../handlers.mjs').Decision} decision
 * @param {string} hookEvent
 */
export function render(decision, hookEvent) {
  const event = EVENT_NAMES[hookEvent] || hookEvent;
  const type = decision?.type;
  if (event === 'preToolUse') {
    if (type === 'deny' || type === 'ask') return { permissionDecision: type, permissionDecisionReason: decision?.reason };
    return null;
  }
  if (event === 'postToolUse' || event === 'postToolUseFailure') {
    if (type === 'context') return { additionalContext: decision?.text };
    if (type === 'halt') return { additionalContext: decision?.agentNote || decision?.message };
    return null;
  }
  if (event === 'agentStop' && type === 'block' && decision?.reason) return { decision: 'block', reason: asFollowUp(decision.reason) };
  return null;
}

/** Copilot has no plan files that Keel reads. */
export function plansDir() {
  return null;
}
