// One driver per agent for the conformance suite. Each driver sends that
// agent's own payload shapes (recorded for Claude Code and Codex, taken from
// the documentation for the others) and turns the agent's output into one
// common shape, so every scenario reads the same for every agent:
//
//   { denied, asked, reason, guidance, sentBack, silent, halted }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeWorld, KEEL_EXEC, KEEL_PRE } from '../replay/harness.mjs';
import * as claudeCaps from '../../src/adapters/claude-code.mjs';
import * as codexCaps from '../../src/adapters/codex.mjs';
import * as cursorCaps from '../../src/adapters/cursor.mjs';
import * as copilotCaps from '../../src/adapters/copilot.mjs';
import * as antigravityCaps from '../../src/adapters/antigravity.mjs';
import * as opencodeCaps from '../../src/adapters/opencode.mjs';
import { KeelPlugin } from '../../opencode/plugin.mjs';

/**
 * @typedef {{denied: boolean, asked: boolean, reason: string|null, guidance: string|null, sentBack: string|null, silent: boolean, halted: boolean, raw: any}} Result
 * @typedef {object} Driver
 * @property {string} name
 * @property {any} caps
 * @property {string} repo
 * @property {string} home
 * @property {() => Promise<Result>} start
 * @property {(text: string) => Promise<Result>} prompt
 * @property {(command: string) => Promise<Result>} preShell
 * @property {((file: string) => Promise<Result>)|null} preRead
 * @property {(command: string, o: {exit: number, output: string}) => Promise<Result>} ran
 * @property {(rel: string, content: string) => Promise<Result>} edited
 * @property {(message: string, o?: {again?: boolean}) => Promise<Result>} stop
 * @property {(() => Promise<Result>)|null} batch
 */

/** @param {Partial<Result>} r @returns {Result} */
function result(r) {
  return { denied: false, asked: false, reason: null, guidance: null, sentBack: null, silent: false, halted: false, raw: null, ...r };
}

/** Spawns `keel hook <event> <agent>`. @returns {{out: string, json: any}} */
function shim(event, agent, payload, env) {
  const res = spawnSync(KEEL_EXEC, [...KEEL_PRE, 'hook', event, agent], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, ...env },
  });
  const out = res.stdout || '';
  if (res.status !== 0) throw new Error(`keel hook exited ${res.status}: ${res.stderr}`);
  return { out, json: out ? JSON.parse(out) : null };
}

/** Claude Code and Codex share output shapes. @param {{out: string, json: any}} r */
function fromClaudeLike(r) {
  const h = r.json?.hookSpecificOutput;
  const decision = h?.permissionDecision;
  return result({
    raw: r.json,
    denied: decision === 'deny',
    asked: decision === 'ask',
    reason: h?.permissionDecisionReason ?? r.json?.reason ?? null,
    guidance: h?.additionalContext ?? null,
    sentBack: r.json?.decision === 'block' ? r.json.reason : null,
    halted: r.json?.continue === false,
    silent: r.out === '',
  });
}

export async function claudeCode() {
  const w = makeWorld();
  const s = w.session();
  return /** @type {Driver} */ ({
    name: 'claude-code', caps: claudeCaps.CAPS, repo: s.repo, home: w.home,
    start: async () => fromClaudeLike(s.start()),
    prompt: async (text) => fromClaudeLike(s.prompt(text)),
    preShell: async (command) => fromClaudeLike(s.pre('Bash', { command })),
    preRead: async (file) => fromClaudeLike(s.pre('Read', { file_path: path.join(s.repo, file) })),
    ran: async (command, o) => fromClaudeLike(s.bash(command, o.exit === 0 ? { stdout: o.output } : { exit: o.exit, error: o.output })),
    edited: async (rel, content) => fromClaudeLike(s.edit(rel, content)),
    stop: async (message, o = {}) => fromClaudeLike(s.stop(message, { active: !!o.again })),
    batch: async () => fromClaudeLike(s.batch()),
  });
}

export async function codex() {
  const w = makeWorld();
  const c = w.codex();
  return /** @type {Driver} */ ({
    name: 'codex', caps: codexCaps.CAPS, repo: w.repo, home: w.home,
    start: async () => fromClaudeLike(c.start()),
    prompt: async (text) => fromClaudeLike(c.prompt(text)),
    preShell: async (command) => fromClaudeLike(c.pre(command)),
    preRead: null,
    ran: async (command, o) => fromClaudeLike(c.bash(command, o)),
    edited: async (rel, content) => fromClaudeLike(c.patch(rel, content)),
    stop: async (message, o = {}) => fromClaudeLike(c.stop(message, { active: !!o.again })),
    batch: null,
  });
}

export async function cursor() {
  const w = makeWorld();
  const repo = w.repo;
  const conversation = crypto.randomUUID();
  let generation = crypto.randomUUID();
  let n = 0;
  const env = { KEEL_HOME: w.home, CURSOR_PROJECT_DIR: repo, CLAUDE_PROJECT_DIR: repo };
  const send = (event, fields) => shim(event, 'cursor', {
    conversation_id: conversation, generation_id: generation, model: 'test-model', hook_event_name: event,
    cursor_version: '2.0.0', workspace_roots: [repo], user_email: 'someone@example.com', transcript_path: null, ...fields,
  }, env);
  const norm = (r) => {
    const j = r.json || {};
    return result({
      raw: j,
      denied: j.permission === 'deny',
      asked: j.permission === 'ask' || (j.permission === 'deny' && /ask the user/i.test(j.agent_message || '')),
      reason: j.agent_message ?? null,
      guidance: j.additional_context ?? null,
      sentBack: j.followup_message ?? null,
      silent: r.out === '' || JSON.stringify(j) === '{"permission":"allow"}',
    });
  };
  return /** @type {Driver} */ ({
    name: 'cursor', caps: cursorCaps.CAPS, repo, home: w.home,
    start: async () => norm(send('sessionStart', { session_id: conversation, is_background_agent: false, composer_mode: 'agent' })),
    prompt: async (text) => { generation = crypto.randomUUID(); return norm(send('beforeSubmitPrompt', { prompt: text, attachments: [] })); },
    preShell: async (command) => norm(send('beforeShellExecution', { command, cwd: repo, sandbox: false })),
    preRead: async (file) => norm(send('beforeReadFile', { file_path: path.join(repo, file), content: '', attachments: [] })),
    ran: async (command, o) => norm(o.exit === 0
      ? send('postToolUse', { tool_name: 'Shell', tool_input: { command, cwd: repo }, tool_output: JSON.stringify({ exitCode: 0, stdout: o.output }), tool_use_id: `t${++n}`, cwd: repo, duration: 5 })
      : send('postToolUseFailure', { tool_name: 'Shell', tool_input: { command, cwd: repo }, tool_use_id: `t${++n}`, cwd: repo, error_message: `Exit code: ${o.exit}\n${o.output}`, failure_type: 'error', duration: 5, is_interrupt: false })),
    edited: async (rel, content) => {
      fs.writeFileSync(path.join(repo, rel), content);
      return norm(send('postToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(repo, rel) }, tool_output: 'Wrote file', tool_use_id: `t${++n}`, cwd: repo, duration: 1 }));
    },
    stop: async (message, o = {}) => {
      send('afterAgentResponse', { text: message });
      return norm(send('stop', { status: 'completed', loop_count: o.again ? 1 : 0 }));
    },
    batch: null,
  });
}

export async function copilot() {
  const w = makeWorld();
  const repo = w.repo;
  const sessionId = crypto.randomUUID();
  const transcript = path.join(w.base, `copilot-${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '');
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  const env = { KEEL_HOME: w.home };
  const send = (event, fields) => shim(event, 'copilot', { sessionId, timestamp: Date.now(), cwd: repo, ...fields }, env);
  const norm = (r) => {
    const j = r.json || {};
    return result({
      raw: j,
      denied: j.permissionDecision === 'deny',
      asked: j.permissionDecision === 'ask',
      reason: j.permissionDecisionReason ?? null,
      guidance: j.additionalContext ?? null,
      sentBack: j.decision === 'block' ? j.reason : null,
      silent: r.out === '',
    });
  };
  return /** @type {Driver} */ ({
    name: 'copilot', caps: copilotCaps.CAPS, repo, home: w.home,
    start: async () => norm(send('sessionStart', { source: 'new' })),
    prompt: async (text) => norm(send('userPromptSubmitted', { prompt: text })),
    preShell: async (command) => norm(send('preToolUse', { toolName: shell, toolArgs: { command, description: 'run', mode: 'sync', initial_wait: 120 } })),
    preRead: async (file) => norm(send('preToolUse', { toolName: 'view', toolArgs: JSON.stringify({ path: path.join(repo, file) }) })),
    ran: async (command, o) => norm(send('postToolUse', {
      toolName: shell, toolArgs: JSON.stringify({ command }),
      // The shape recorded from Copilot CLI 1.0.98.
      toolResult: { resultType: 'success', textResultForLlm: `${o.output}\n<shellId: 0 completed with exit code ${o.exit}>` },
    })),
    edited: async (rel, content) => {
      fs.writeFileSync(path.join(repo, rel), content);
      return norm(send('postToolUse', { toolName: 'edit', toolArgs: { path: path.join(repo, rel), old_str: 'a', new_str: 'b' }, toolResult: { resultType: 'success', textResultForLlm: 'File edited.' } }));
    },
    stop: async (message, o = {}) => {
      fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant.message', data: { content: message } }) + '\n');
      return norm(send('agentStop', { transcriptPath: transcript, stopReason: 'end_turn', stop_hook_active: !!o.again }));
    },
    batch: null,
  });
}

export async function antigravity() {
  const w = makeWorld();
  const repo = w.repo;
  const conversationId = crypto.randomUUID();
  const transcript = path.join(w.base, `agy-${conversationId}.jsonl`);
  fs.writeFileSync(transcript, '');
  // Shapes recorded from agy 1.4.2: the transcript is a step log; a tool's
  // step (with "The command exited with code N.") is written only after its
  // PostToolUse hook returns; PostToolUse sends error: "" even on failure;
  // PreToolUse must answer {"decision":"allow"}.
  let step = 0;
  let invocation = 0;
  const env = { KEEL_HOME: w.home };
  const writeStep = (s) => fs.appendFileSync(transcript, JSON.stringify({ step_index: step++, status: 'DONE', created_at: new Date().toISOString(), ...s }) + '\n');
  const send = (event, fields) => shim(event, 'antigravity', {
    conversationId, workspacePaths: [repo], transcriptPath: transcript, artifactDirectoryPath: w.base, modelName: 'gemini-test', ...fields,
  }, env);
  const norm = (r) => {
    const j = r.json || {};
    return result({
      raw: j,
      denied: j.decision === 'deny',
      asked: j.decision === 'ask' || j.decision === 'force_ask',
      reason: j.reason ?? null,
      guidance: j.injectSteps?.[0]?.systemMessage?.systemMessage ?? null,
      sentBack: j.decision === 'continue' ? j.reason : null,
      silent: r.out === '' || r.out === '{}' || r.out === '{"decision":"allow"}',
    });
  };
  const call = (name, args) => ({ toolCall: { name, args }, stepIdx: step });
  const tool = async (name, args, content) => {
    const at = step;
    const r = norm(send('PostToolUse', { toolCall: { name, args }, stepIdx: at, error: '' }));
    writeStep({ step_index: at, source: 'MODEL', type: 'GENERIC', content });
    step = at + 1;
    return r;
  };
  const driver = /** @type {Driver & {invocation: () => Promise<Result>}} */ ({
    name: 'antigravity', caps: antigravityCaps.CAPS, repo, home: w.home,
    start: async () => norm(send('SessionStart', {})),
    prompt: async (text) => {
      writeStep({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: now.\n</ADDITIONAL_METADATA>` });
      return norm(send('PreInvocation', { invocationNum: invocation++, initialNumSteps: step }));
    },
    invocation: async () => norm(send('PreInvocation', { invocationNum: invocation++, initialNumSteps: step })),
    preShell: async (command) => norm(send('PreToolUse', call('run_command', { CommandLine: command, Cwd: repo, WaitMsBeforeAsync: 0 }))),
    preRead: async (file) => norm(send('PreToolUse', call('view_file', { AbsolutePath: path.join(repo, file) }))),
    ran: (command, o) => tool('run_command', { CommandLine: command, Cwd: repo }, `Created At: now\nCompleted At: now\n\nThe command exited with code ${o.exit}.\nOutput:\n\n${o.output}\n`),
    edited: async (rel, content) => {
      fs.writeFileSync(path.join(repo, rel), content);
      return tool('replace_file_content', { TargetFile: path.join(repo, rel), Instruction: 'edit' }, `The following changes were made by the replace_file_content tool to: ${path.join(repo, rel)}`);
    },
    stop: async (message) => {
      writeStep({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: message, input_tokens: 100, output_tokens: 20, cache_read_tokens: 0 });
      return norm(send('Stop', { executionNum: 0, terminationReason: 'NO_TOOL_CALL', fullyIdle: true, error: '' }));
    },
    batch: null,
  });
  return driver;
}

export async function opencode() {
  const w = makeWorld();
  const repo = w.repo;
  const sessionID = `ses_${crypto.randomUUID()}`;
  /** @type {{prompts: string[], toasts: string[], messages: any[]}} */
  const seen = { prompts: [], toasts: [], messages: [] };
  const client = {
    session: {
      messages: async () => ({ data: seen.messages }),
      promptAsync: async ({ body }) => { seen.prompts.push(body.parts[0].text); },
    },
    tui: { showToast: async ({ body }) => { seen.toasts.push(body.message); } },
  };
  // The plugin runs inside OpenCode's process, so Keel's home comes from this process's environment.
  const withHome = async (fn) => {
    const before = process.env.KEEL_HOME;
    process.env.KEEL_HOME = w.home;
    try { return await fn(); } finally { if (before === undefined) delete process.env.KEEL_HOME; else process.env.KEEL_HOME = before; }
  };
  const hooks = await KeelPlugin({ client, directory: repo, worktree: repo });
  let n = 0;
  const system = async () => {
    const output = { system: [] };
    await hooks['experimental.chat.system.transform']({ sessionID, model: {} }, output);
    return output.system.join('\n') || null;
  };
  const before = (tool, args) => withHome(async () => {
    try {
      await hooks['tool.execute.before']({ tool, sessionID, callID: `c${++n}` }, { args });
      return result({ silent: true });
    } catch (err) {
      const reason = /** @type {Error} */ (err).message;
      return result({ denied: true, asked: /ask (the user )?whether/i.test(reason), reason });
    }
  });
  const after = (tool, args, output, metadata) => withHome(async () => {
    const out = { title: tool, output, metadata };
    await hooks['tool.execute.after']({ tool, sessionID, callID: `c${++n}`, args }, out);
    const added = out.output.slice(output.length).trim();
    return result({ guidance: added || null, silent: !added, raw: out });
  });
  return /** @type {Driver} */ ({
    name: 'opencode', caps: opencodeCaps.CAPS, repo, home: w.home,
    start: async () => withHome(async () => {
      await hooks.event({ event: { type: 'session.created', properties: { info: { id: sessionID } } } });
      return result({ silent: seen.toasts.length === 0 });
    }),
    prompt: async (text) => withHome(async () => {
      await hooks['chat.message']({ sessionID, messageID: `msg_${++n}` }, { message: { id: `msg_${n}` }, parts: [{ type: 'text', text }] });
      const guidance = await system();
      return result({ guidance, silent: !guidance });
    }),
    preShell: (command) => before('bash', { command }),
    preRead: (file) => before('read', { filePath: path.join(repo, file) }),
    ran: (command, o) => after('bash', { command }, o.output, { exit: o.exit }),
    edited: (rel, content) => {
      fs.writeFileSync(path.join(repo, rel), content);
      return after('edit', { filePath: path.join(repo, rel) }, 'Edit applied.', {});
    },
    stop: async (message) => withHome(async () => {
      seen.messages.push({ info: { role: 'assistant' }, parts: [{ type: 'text', text: message }] });
      const count = seen.prompts.length;
      await hooks.event({ event: { type: 'session.idle', properties: { sessionID } } });
      const sent = seen.prompts.length > count ? seen.prompts[seen.prompts.length - 1] : null;
      return result({ sentBack: sent, silent: !sent });
    }),
    batch: null,
  });
}

export const DRIVERS = { 'claude-code': claudeCode, codex, cursor, copilot, antigravity, opencode };
