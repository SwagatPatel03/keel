// Codex adapter: turns Codex hook payloads into canonical events and Keel
// decisions back into Codex hook output.
//
// Payload shapes were recorded from Codex 0.161.0 on Windows (see
// test/fixtures/codex). Differences from Claude Code that matter here:
// - Shell commands arrive as tool "Bash" (they run through PowerShell on Windows).
// - PostToolUse fires for failed commands too, with the output text but no
//   exit code; the exit code is read from the session's rollout file.
// - Edits arrive as apply_patch, with file paths inside the patch.
// - There is no batch hook, no plan-approval tool, and no "ask" decision, and
//   continue:false is not supported on tool hooks.

import fs from 'node:fs';
import { patchFiles as parsePatchFiles } from './common.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeEvent } from '../events.mjs';
import { excerpt } from '../redact.mjs';
import { classifyCommand, normaliseError, normaliseCommand } from '../checks.mjs';
import { errorLine } from './claude-code.mjs';

export const AGENT = 'codex';

/** What this agent's hooks can do. */
export const CAPS = Object.freeze({ name: AGENT, batchHook: false, ask: false, planTool: false, promptContext: true, userNotice: false });

/** Hook events where continue:false stops Codex: none of the tool hooks. */
export const HALT_EVENTS = new Set();

/**
 * @param {any} payload  Hook stdin JSON.
 * @param {string} root  Project folder.
 */
export function toEvent(payload, root) {
  const ctx = { agent: AGENT, session: String(payload.session_id || 'unknown'), turn: payload.turn_id || null };
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return makeEvent('session_start', ctx, { source: payload.source || null, root, transcript: payload.transcript_path || null });
    case 'UserPromptSubmit':
      return makeEvent('turn_start', ctx, { promptChars: String(payload.prompt || '').length });
    case 'PreToolUse':
      return makeEvent('tool_call', ctx, { tool: String(payload.tool_name || 'unknown'), toolUseId: payload.tool_use_id || payload.call_id || null });
    case 'PostToolUse':
      return makeEvent('tool_result', ctx, toolResult(payload, root));
    case 'Stop':
      return makeEvent('turn_end', ctx, { stopHookActive: !!payload.stop_hook_active, planMode: payload.permission_mode === 'plan' });
    default:
      return null;
  }
}

/** @param {any} p @param {string} root */
function toolResult(p, root) {
  const tool = String(p.tool_name || 'unknown');
  const input = p.tool_input || {};
  // Codex 0.161.0 sends the output as plain text. Some guides show an object
  // with exit_code; when a newer Codex sends one, its fields are used first.
  const resp = p.tool_response && typeof p.tool_response === 'object' ? p.tool_response : null;
  const reported = typeof resp?.exit_code === 'number' ? resp.exit_code : typeof resp?.exitCode === 'number' ? resp.exitCode : null;
  const text = resp ? [resp.output, resp.stdout, resp.stderr].filter((s) => typeof s === 'string').join('\n') : '';
  const output = typeof p.tool_response === 'string' ? p.tool_response : text || JSON.stringify(p.tool_response ?? '');
  const r = {
    tool, toolUseId: p.tool_use_id || null, ok: true, exitCode: null, command: null, isTest: false, isBuild: false,
    files: [], fileHash: null, originalHash: null, errorExcerpt: null, errorFingerprint: null, commandKey: null,
  };

  if (tool === 'apply_patch') {
    const patch = String(input.command || input.patch || '');
    r.files = patchFiles(patch).map((f) => relPath(root, f)).filter((f) => !f.startsWith('../'));
    const code = /Exit code:\s*(\d+)/.exec(output);
    r.exitCode = code ? Number(code[1]) : null;
    r.ok = code ? r.exitCode === 0 : /error|failed/i.test(output) ? false : null;
    if (r.ok && r.files.length) r.fileHash = hashFile(path.join(root, r.files[0]));
    if (r.ok === false) {
      r.errorExcerpt = excerpt(errorLine(output), 200);
      r.errorFingerprint = hash(`apply_patch\n${normaliseError(output)}`);
    }
    return r;
  }

  if (typeof input.command === 'string') {
    r.command = excerpt(input.command, 200);
    r.commandKey = hash(normaliseCommand(input.command));
    Object.assign(r, classifyCommand(input.command));
    r.exitCode = reported ?? exitCodeFromRollout(p.transcript_path, output);
    r.ok = r.exitCode == null ? null : r.exitCode === 0;
    if (r.ok === false) {
      r.errorExcerpt = excerpt(errorLine(output), 200);
      r.errorFingerprint = hash(`${tool}\n${normaliseError(output)}`);
    }
  }
  return r;
}

/** Files named in an apply_patch body. @param {string} patch */
export function patchFiles(patch) { return parsePatchFiles(patch); }

/**
 * The exit code of the command whose output was just reported: the newest
 * tool output in the rollout whose text matches the hook's output.
 * @param {string|undefined} rolloutPath
 * @param {string} output
 */
export function exitCodeFromRollout(rolloutPath, output) {
  let text;
  try { text = fs.readFileSync(String(rolloutPath), 'utf8'); } catch { return null; }
  const want = String(output).trim();
  const lines = text.split('\n');
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 40; i--) {
    const line = lines[i];
    if (!line.includes('exit_code')) continue;
    seen++;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const parts = e.payload?.output;
    for (const part of Array.isArray(parts) ? parts : [{ text: parts }]) {
      let inner;
      try { inner = JSON.parse(part?.text ?? ''); } catch { continue; }
      if (inner && typeof inner.exit_code === 'number' && String(inner.output ?? '').trim() === want) return inner.exit_code;
    }
  }
  return null;
}

/**
 * Turns a Keel decision into Codex hook output.
 * @param {import('../handlers.mjs').Decision & {notice?: string}} decision
 * @param {string} hookEvent
 */
export function render(decision, hookEvent) {
  /** @type {Record<string, any>} */
  let out = {};
  switch (decision?.type) {
    case 'block':
      out = { decision: 'block', reason: decision.reason };
      break;
    case 'halt':
      // Codex cannot be halted from a tool hook: tell it to stop now, and the
      // next PreToolUse refuses every tool until the user's next prompt.
      out = { decision: 'block', reason: decision.agentNote || decision.message, systemMessage: decision.message };
      break;
    case 'context':
      out = { hookSpecificOutput: { hookEventName: hookEvent, additionalContext: decision.text } };
      break;
    case 'deny':
    case 'ask':
      out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason } };
      break;
    case 'notify':
      out = { systemMessage: decision.message };
      break;
    default:
      break;
  }
  if (decision?.notice) out.systemMessage = [out.systemMessage, decision.notice].filter(Boolean).join('\n');
  return Object.keys(out).length ? out : null;
}

/** Codex has no plan files; plans are read from the final message. */
export function plansDir() {
  return null;
}

/** @param {string} root @param {string} abs */
function relPath(root, abs) {
  return path.relative(root, path.resolve(root, abs)).split(path.sep).join('/');
}

/** @param {string} s */
function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** @param {string} abs */
function hashFile(abs) {
  try { return hash(fs.readFileSync(abs, 'utf8')); } catch { return hash('<missing>'); }
}
