// Claude Code adapter: turns hook payloads into canonical events and turns
// Keel decisions back into Claude Code hook output.
//
// Payload shapes were recorded from Claude Code 2.1.291; the replay fixtures
// in test/fixtures/claude-code keep them honest across versions.

import fs from 'node:fs';
import { cumulativeUsage } from '../budget.mjs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeEvent, FILE_WRITE_TOOLS, SHELL_TOOLS } from '../events.mjs';
import { excerpt } from '../redact.mjs';
import { classifyCommand, normaliseError, normaliseCommand } from '../checks.mjs';

export const AGENT = 'claude-code';

/** What this agent's hooks can do. */
export const CAPS = Object.freeze({ name: AGENT, batchHook: true, ask: true, planTool: true, promptContext: true, userNotice: true });

/**
 * @param {any} payload  Hook stdin JSON.
 * @param {string} root  Project folder.
 * @returns {any|null}   A canonical event, or null when the hook is not one Keel uses.
 */
export function toEvent(payload, root) {
  const ctx = { agent: AGENT, session: String(payload.session_id || 'unknown'), turn: payload.prompt_id || null };
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return makeEvent('session_start', ctx, { source: payload.source || null, root, transcript: payload.transcript_path || null });
    case 'UserPromptSubmit':
      // The prompt text is not stored; only its length, for the receipt.
      return makeEvent('turn_start', ctx, { promptChars: String(payload.prompt || '').length, planMode: payload.permission_mode === 'plan' });
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return makeEvent('tool_result', ctx, toolResult(payload, root));
    case 'PostToolBatch':
      return makeEvent('batch_end', ctx, {});
    case 'PreToolUse':
      // ExitPlanMode: Claude is about to show its plan for approval. Every
      // other hooked tool goes to the guard.
      return payload.tool_name === 'ExitPlanMode'
        ? makeEvent('plan_ready', ctx, {toolUseId:payload.tool_use_id || payload.call_id || null})
        : makeEvent('tool_call', ctx, { tool: String(payload.tool_name || 'unknown'), toolUseId: payload.tool_use_id || payload.call_id || null });
    case 'Stop':
      return makeEvent('turn_end', ctx, { stopHookActive: !!payload.stop_hook_active, planMode: payload.permission_mode === 'plan' });
    case 'SessionEnd':
      return makeEvent('session_end', ctx, { reason: payload.reason || null });
    case 'SubagentStart':
    case 'SubagentStop':
      return makeEvent(payload.hook_event_name === 'SubagentStart' ? 'subagent_start' : 'subagent_end', ctx, {
        parentSession: ctx.session, childSession: payload.agent_id || payload.subagent_id || null,
        usage: payload.agent_transcript_path ? cumulativeUsage(AGENT, payload.agent_transcript_path) : null,
      });
    default:
      return null;
  }
}

/** @param {any} p @param {string} root */
function toolResult(p, root) {
  const tool = String(p.tool_name || 'unknown');
  const failed = p.hook_event_name === 'PostToolUseFailure';
  const input = p.tool_input || {};
  const response = p.tool_response;
  /** @type {import('../events.mjs').ToolResult} */
  const r = {
    tool,
    toolUseId: p.tool_use_id || null,
    ok: !failed,
    exitCode: null,
    command: null,
    isTest: false,
    isBuild: false,
    files: [],
    fileHash: null,
    originalHash: null,
    errorExcerpt: null,
    errorFingerprint: null,
    commandKey: null,
  };

  if (SHELL_TOOLS.has(tool) && typeof input.command === 'string') {
    r.command = excerpt(input.command, 200);
    r.commandKey = hash(normaliseCommand(input.command));
    Object.assign(r, classifyCommand(input.command));
    if (!failed) r.exitCode = 0;
  }

  if (failed) {
    const error = String(p.error ?? '');
    const m = /^Exit code (\d+)/.exec(error);
    if (m) r.exitCode = Number(m[1]);
    r.errorExcerpt = excerpt(errorLine(error), 200);
    if (!p.is_interrupt) r.errorFingerprint = hash(`${tool}\n${normaliseError(error)}`);
  }

  if (FILE_WRITE_TOOLS.has(tool) && !failed) {
    const abs = input.file_path || input.notebook_path || response?.filePath;
    const rel = abs ? relPath(root, abs) : null;
    // Files outside the project (such as Claude's own plan files, whose names
    // come from the prompt) are not recorded at all.
    if (rel && !rel.startsWith('../') && !path.isAbsolute(rel)) {
      r.files = [rel];
      r.fileHash = hashFile(abs);
      if (response && typeof response.originalFile === 'string') r.originalHash = hash(response.originalFile);
    }
  }
  return r;
}

/** Output that blocks Claude from stopping and tells it what to fix. */
export function blockStop(reason) {
  return { decision: 'block', reason };
}

/**
 * Output that halts Claude entirely and shows the user why.
 *
 * Claude Code 2.1.291 ignores continue:false on PostToolUseFailure (seen in a
 * live run), while the docs promise it for PostToolUse and PreToolUse. So a
 * failure hook also tells Claude directly (decision:block) to stop retrying,
 * and the PostToolBatch hook that follows delivers the hard stop.
 * @param {string} message      Shown to the user.
 * @param {string} hookEvent
 * @param {string} [agentNote]  Shown to Claude next to the tool result.
 */
export function haltSession(message, hookEvent, agentNote) {
  const out = { continue: false, stopReason: message };
  if (hookEvent === 'PostToolUseFailure' && agentNote) Object.assign(out, { decision: 'block', reason: agentNote });
  return out;
}

/** Hook events where continue:false is documented to stop Claude. */
export const HALT_EVENTS = new Set(['PostToolUse', 'PreToolUse']);

/**
 * The most telling line of a tool error: a line that starts with an error
 * name, else a line that mentions an error or failure, else the first line.
 * @param {string} error
 */
export function errorLine(error) {
  const lines = String(error).replace(/^Exit code \d+\s*/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const named = lines.find((l) => /^(\w*(Error|Exception)\b|FAIL\b|✖|panic:|fatal:|error(\[\w+\])?:|E\s+\w)/i.test(l));
  return named || lines.find((l) => !/^at\s/.test(l) && /error|fail|exception/i.test(l)) || lines[0] || '';
}

/** Output that shows the user a message without adding anything to Claude's context. */
export function notifyUser(message) {
  return { systemMessage: message };
}

/** Output that adds instructions to Claude's context for this turn. */
export function addContext(hookEvent, text) {
  return { hookSpecificOutput: { hookEventName: hookEvent, additionalContext: text } };
}

/** Output that refuses a tool call and tells Claude why. */
export function denyTool(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** Output that makes Claude Code ask the user, showing Keel's reason. */
export function askUser(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } };
}

/**
 * Turns a Keel decision into Claude Code hook output. A notice (a budget
 * warning) is added as a user-only systemMessage.
 * @param {import('../handlers.mjs').Decision & {notice?: string}} decision
 * @param {string} hookEvent
 */
export function render(decision, hookEvent) {
  /** @type {Record<string, any>|null} */
  let out = null;
  switch (decision?.type) {
    case 'block': out = blockStop(decision.reason); break;
    case 'halt': out = haltSession(decision.message, hookEvent, decision.agentNote); break;
    case 'context': out = addContext(hookEvent, decision.text); break;
    case 'deny': out = denyTool(decision.reason); break;
    case 'ask': out = askUser(decision.reason); break;
    case 'notify': out = notifyUser(decision.message); break;
    default: break;
  }
  if (decision?.notice) {
    out = out || {};
    out.systemMessage = [out.systemMessage, decision.notice].filter(Boolean).join('\n');
  }
  return out;
}

/**
 * Where Claude Code may keep plan files: the folders named by plansDirectory
 * in the project's and the user's settings (relative paths from the project
 * root), and the default plans folder in the config folder that holds the
 * session transcript (<config>/projects/<project>/<session>.jsonl), else
 * CLAUDE_CONFIG_DIR, else ~/.claude. Bug reports say the setting is not always
 * honoured, so the default folder is always checked too.
 * @param {string|null} transcriptPath @param {string|null} [root]
 * @returns {string[]}
 */
export function plansDir(transcriptPath, root = null) {
  const config = transcriptPath
    ? path.dirname(path.dirname(path.dirname(transcriptPath)))
    : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settings = [
    ...(root ? [path.join(root, '.claude', 'settings.local.json'), path.join(root, '.claude', 'settings.json')] : []),
    path.join(config, 'settings.json'),
  ];
  const dirs = [];
  for (const file of settings) {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8'))?.plansDirectory; } catch { continue; }
    if (typeof value !== 'string' || !value.trim()) continue;
    const p = value.trim().replace(/^~(?=[\\/]|$)/, os.homedir());
    dirs.push(path.isAbsolute(p) ? p : path.resolve(root || process.cwd(), p));
  }
  dirs.push(path.join(config, 'plans'));
  return [...new Set(dirs)];
}

/** @param {string} root @param {string} abs */
export function relPath(root, abs) {
  const rel = path.relative(root, path.resolve(root, abs));
  return rel.split(path.sep).join('/');
}

/** @param {string} s */
export function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** @param {string} abs */
function hashFile(abs) {
  try { return hash(fs.readFileSync(abs, 'utf8')); } catch { return hash('<missing>'); }
}
