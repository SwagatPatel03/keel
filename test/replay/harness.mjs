// Replays Claude Code hook payloads through the real hook shim (bin/keel.mjs)
// against a fresh copy of the seeded repo, with Keel's store in a temp folder.
// Payload shapes follow test/fixtures/claude-code/recorded-2.1.291.jsonl.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const KEEL_BIN = path.join(here, '..', '..', 'bin', 'keel.mjs');
// The program the tests run: node with bin/keel.mjs, or a compiled Keel when
// KEEL_TEST_EXE names one (scripts/build-binaries.mjs --test does this).
export const KEEL_EXEC = process.env.KEEL_TEST_EXE || process.execPath;
export const KEEL_PRE = process.env.KEEL_TEST_EXE ? [] : [KEEL_BIN];
// Hooks in replayed sessions start no background checkpoint pruning.
process.env.KEEL_NO_BACKGROUND = '1';
const SEEDED = path.join(here, '..', 'seeded-repo');

const worlds = [];
process.on('exit', () => {
  for (const dir of worlds) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

/**
 * A temporary project, Keel home and agent folders.
 * @param {{firstRun?: boolean}} [opts]  firstRun: a machine where Keel has never
 *   shown its one-time learning notice. By default the notice was already shown.
 */
export function makeWorld({ firstRun = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-replay-'));
  worlds.push(base);
  const repo = path.join(base, 'shop');
  const home = path.join(base, 'keel-home');
  fs.cpSync(SEEDED, repo, { recursive: true });
  if (!firstRun) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'learn-notice-shown'), 'replay');
  }
  // Mirror Claude Code's layout: <config>/projects/<project>/<session>.jsonl and <config>/plans/.
  const transcript = path.join(base, 'claude', 'projects', 'shop', 'transcript.jsonl');
  const plans = path.join(base, 'claude', 'plans');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(plans, { recursive: true });
  fs.writeFileSync(transcript, '');
  return {
    base, repo, home, transcript, plans,
    session: (id) => new Session({ repo, home, transcript, id, plans }),
    codex: () => new CodexSession({ repo, home, base }),
    /** Writes ~/.keel/config.json for this world. */
    config: (cfg) => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg)); },
  };
}

export class Session {
  constructor({ repo, home, transcript, id, plans }) {
    this.repo = repo;
    this.home = home;
    this.transcript = transcript;
    this.plans = plans;
    this.mode = 'default';
    this.id = id || crypto.randomUUID();
    this.promptId = null;
    this.toolN = 0;
  }

  common(event) {
    return {
      session_id: this.id,
      transcript_path: this.transcript,
      cwd: this.repo,
      prompt_id: this.promptId ?? undefined,
      permission_mode: this.mode,
      hook_event_name: event,
    };
  }

  /** Runs the hook shim and returns { out, json, status }. */
  hook(event, extra = {}) {
    const res = spawnSync(KEEL_EXEC, [...KEEL_PRE, 'hook', event], {
      input: JSON.stringify({ ...this.common(event), ...extra }),
      encoding: 'utf8',
      env: { ...process.env, KEEL_HOME: this.home, CLAUDE_PROJECT_DIR: this.repo },
    });
    const out = res.stdout || '';
    return { out, json: out ? JSON.parse(out) : null, status: res.status, stderr: res.stderr };
  }

  /** Runs a CLI command (revert, receipt) inside the project. */
  cli(...args) {
    const res = spawnSync(KEEL_EXEC, [...KEEL_PRE, ...args], {
      cwd: this.repo, encoding: 'utf8', env: { ...process.env, KEEL_HOME: this.home, CLAUDE_PROJECT_DIR: this.repo },
    });
    return res.stdout;
  }

  start(source = 'startup') { return this.hook('SessionStart', { source }); }

  prompt(text = 'Please fix the cart.') {
    this.promptId = crypto.randomUUID();
    return this.hook('UserPromptSubmit', { prompt: text });
  }

  /** A shell command that succeeded or failed (exit code and error text). */
  bash(command, { exit = 0, stdout = '', error = '' } = {}) {
    const id = this.toolUse('Bash');
    if (exit === 0) {
      return this.hook('PostToolUse', {
        tool_name: 'Bash', tool_input: { command, description: 'run' }, tool_use_id: id,
        tool_response: { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
      });
    }
    return this.hook('PostToolUseFailure', {
      tool_name: 'Bash', tool_input: { command, description: 'run' }, tool_use_id: id,
      error: `Exit code ${exit}\n${error}`, is_interrupt: false,
    });
  }

  /** Writes a file in the project and reports it as an Edit tool call. */
  edit(rel, content) {
    const abs = path.join(this.repo, rel);
    const original = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    const id = this.toolUse('Edit');
    return this.hook('PostToolUse', {
      tool_name: 'Edit', tool_input: { file_path: abs, old_string: original, new_string: content, replace_all: false }, tool_use_id: id,
      tool_response: { filePath: abs, oldString: original, newString: content, originalFile: original, structuredPatch: [] },
    });
  }

  /** Claude writes its plan file in plan mode (a Write outside the project). */
  writePlan(text, name = 'add-a-search-bar-quirky-duckling.md') {
    this.mode = 'plan';
    const file = path.join(this.plans, name);
    fs.writeFileSync(file, text);
    const id = this.toolUse('Write');
    return this.hook('PostToolUse', {
      tool_name: 'Write', tool_input: { file_path: file, content: text }, tool_use_id: id,
      tool_response: { type: 'create', filePath: file, content: text },
    });
  }

  /** Claude asks to show its plan for approval. */
  exitPlan() {
    const id = this.toolUse('ExitPlanMode');
    return this.hook('PreToolUse', { tool_name: 'ExitPlanMode', tool_input: {}, tool_use_id: id });
  }

  /** A tool call about to run (PreToolUse): the guard's moment. */
  pre(tool, input) {
    const id = `toolu_pre_${++this.toolN}`;
    return this.hook('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id });
  }

  /** Claude asked the user questions and got answers. */
  askUser() {
    const id = this.toolUse('AskUserQuestion');
    return this.hook('PostToolUse', {
      tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_use_id: id,
      tool_response: { answers: { q1: 'a' } },
    });
  }

  /** The end of a batch of tool calls, before the next model call. */
  batch() { return this.hook('PostToolBatch', {}); }

  stop(message, { active = false } = {}) {
    this.assistant(40);
    return this.hook('Stop', { stop_hook_active: active, last_assistant_message: message, background_tasks: [], session_crons: [] });
  }

  end(reason = 'other') { return this.hook('SessionEnd', { reason }); }

  /** Appends an assistant message that issues a tool call, with token usage, to the transcript. */
  toolUse(name) {
    const id = `toolu_${++this.toolN}_${this.id.slice(0, 6)}`;
    this.assistant(100, { type: 'tool_use', id, name });
    return id;
  }

  assistant(output, block = { type: 'text' }) {
    const entry = {
      type: 'assistant', uuid: crypto.randomUUID(), isSidechain: false,
      message: { role: 'assistant', id: `msg_${crypto.randomUUID()}`, content: [block], usage: { input_tokens: 2, output_tokens: output, cache_creation_input_tokens: 500, cache_read_input_tokens: 10000 } },
    };
    fs.appendFileSync(this.transcript, JSON.stringify(entry) + '\n');
  }
}

/**
 * A Codex session: payloads shaped like the recorded Codex 0.161.0 run, sent
 * through `keel hook <Event> codex`. Exit codes are written to a rollout file,
 * as Codex does, because Codex hooks do not carry them.
 */
export class CodexSession {
  constructor({ repo, home, base }) {
    this.repo = repo;
    this.home = home;
    this.id = crypto.randomUUID();
    this.turnId = null;
    this.n = 0;
    this.rollout = path.join(base, `rollout-${this.id}.jsonl`);
    fs.writeFileSync(this.rollout, '');
    this.totals = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 };
  }

  hook(event, extra = {}) {
    const payload = {
      session_id: this.id, turn_id: this.turnId ?? undefined, transcript_path: this.rollout, cwd: this.repo,
      hook_event_name: event, model: 'gpt-test', permission_mode: 'default', ...extra,
    };
    const res = spawnSync(KEEL_EXEC, [...KEEL_PRE, 'hook', event, 'codex'], {
      input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, KEEL_HOME: this.home },
    });
    const out = res.stdout || '';
    return { out, json: out ? JSON.parse(out) : null, status: res.status };
  }

  start() { return this.hook('SessionStart', { source: 'startup' }); }

  prompt(text) {
    this.turnId = crypto.randomUUID();
    return this.hook('UserPromptSubmit', { prompt: text });
  }

  pre(command) { return this.hook('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: `exec-${++this.n}` }); }

  /** A shell command finishing, with its exit code recorded in the rollout. */
  bash(command, { exit = 0, output = '' } = {}) {
    this.spend(800, 50);
    const inner = JSON.stringify({ chunk_id: 'x', wall_time_seconds: 1, exit_code: exit, original_token_count: 1, output });
    fs.appendFileSync(this.rollout, JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'Script completed\n' }, { type: 'input_text', text: inner }] } }) + '\n');
    return this.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: output, tool_use_id: `exec-${++this.n}` });
  }

  /** An apply_patch edit that writes the file. */
  patch(rel, content) {
    fs.writeFileSync(path.join(this.repo, rel), content);
    const abs = path.join(this.repo, rel).split(path.sep).join('/');
    return this.hook('PostToolUse', {
      tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${abs}\n*** End Patch` },
      tool_response: `Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM ${abs}\n`, tool_use_id: `exec-${++this.n}`,
    });
  }

  /** Model usage as Codex records it: a running total in token_count events. */
  spend(fresh, output) {
    this.totals.input_tokens += fresh + 10000;
    this.totals.cached_input_tokens += 10000;
    this.totals.output_tokens += output;
    fs.appendFileSync(this.rollout, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...this.totals, total_tokens: 0 } } } }) + '\n');
  }

  stop(message, { active = false } = {}) { return this.hook('Stop', { stop_hook_active: active, last_assistant_message: message }); }
}

export const BUGGY_CART = `export function total(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}

export function applyDiscount(amount, percent) {
  return Math.round(amount * (100 - percent)) / 100;
}
`;

export const FIXED_CART = fs.readFileSync(path.join(SEEDED, 'src', 'cart.mjs'), 'utf8');
