#!/usr/bin/env node
// Keel entry point.
//
//   keel hook <EventName> [agent]  Hook shim: reads the agent's hook JSON on stdin. agent is
//                                  claude-code (default), codex, cursor, copilot or antigravity.
//                                  OpenCode loads opencode/plugin.mjs instead.
//   keel revert [undo]             Restore files to the last green checkpoint (or undo that).
//   keel receipt                   Print the receipt for the latest session in this project.
//   keel meter                     Print the current task's token usage. Reads Claude Code's
//                                  status line JSON from stdin when there is any.
//   keel learn [on|off] [here]     Show or change learning notes, for every project or,
//                                  with "here", for this project only.
//   keel install|uninstall <agent> Set Keel up for Cursor, Copilot CLI, OpenCode or Antigravity
//                                  in your user settings, or remove only Keel's entries.
//   keel doctor                    Show where Keel is installed and what it can do in each agent.
//   keel rules [--yes]             Check that every agent reads the same rules (AGENTS.md),
//                                  and offer to make Claude Code read AGENTS.md too.
//
// The hook shim fails open: whatever goes wrong inside Keel, it exits 0 with no
// output (or, for agents that need an answer, an "allow"), so a Keel bug can
// never block or break the agent's session.

import { runAgent, liveProbe } from '../src/supervisor.mjs';
import { reliableCli } from '../src/reliable-cli.mjs';
import { status as currentStatus } from '../src/status.mjs';
import { capabilityMatrix } from '../src/capabilities.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isCompiled, keelRoot } from '../src/runtime.mjs';
import { ProjectStore, resolveRoot, loadConfig, projectSettings, setLearnMode } from '../src/store.mjs';
import * as claudeCode from '../src/adapters/claude-code.mjs';
import * as codex from '../src/adapters/codex.mjs';
import * as cursor from '../src/adapters/cursor.mjs';
import * as copilot from '../src/adapters/copilot.mjs';
import * as antigravity from '../src/adapters/antigravity.mjs';
import { processHook } from '../src/shim.mjs';
import { install, uninstall, doctor } from '../src/install.mjs';
import { runRules } from '../src/rules.mjs';
import { revert, undoRevert } from '../src/revert.mjs';
import { runInteractiveRevert, renderClackStatus, renderStatusline } from '../src/tui.mjs';
import { Shadow } from '../src/checkpoint.mjs';
import { renderReceipt, catches } from '../src/receipt.mjs';
import { sandboxStatus, sandboxLine } from '../src/sandbox.mjs';
import { cumulativeUsage, budgetStatus, meterLine } from '../src/budget.mjs';

const COMPILED = isCompiled(import.meta.url);
const PLUGIN_ROOT = keelRoot(import.meta.url);
/** What the installer writes into other agents' hooks: this executable, when Keel is compiled. */
const INSTALL_FROM = { keelRoot: PLUGIN_ROOT, exe: COMPILED ? process.execPath : undefined };
/** @type {Record<string, import('../src/shim.mjs').Adapter>} */
const ADAPTERS = { 'claude-code': claudeCode, codex, cursor, copilot, antigravity };

/** @param {string[]} args */
export async function main(args) {
  const [command, ...rest] = args;
  if (reliableCli(command, rest)) return;
  switch (command) {
    case 'hook':
      await runHook(rest[0], rest[1]);
      break;
    case 'revert':
      if (rest.includes('-i') || rest.includes('--interactive') || rest.includes('--preview')) {
        try {
          process.stdout.write(await runInteractiveRevert(cliStore(), rest));
        } catch (err) {
          process.stdout.write(`Keel could not finish: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
        }
      } else {
        runCli(() => (rest[0] === 'undo' ? undoRevert(cliStore()) : revert(cliStore())));
      }
      break;
    case 'tui':
      runCli(() => renderClackStatus(cliStore()));
      break;
    case 'statusline':
      await statusline();
      break;
    case 'receipt':
      runCli(() => receipt(cliStore()));
      break;
    case 'meter':
      await meter();
      break;
    case 'learn':
      runCli(() => learn(rest));
      break;
    case 'install':
      runCli(() => install(String(rest[0] || '').toLowerCase(), { ...INSTALL_FROM, preview: rest.includes('--dry-run'), version: rest.includes('--version') ? rest[rest.indexOf('--version') + 1] : undefined, acceptHash: rest.includes('--accept-hash') ? rest[rest.indexOf('--accept-hash') + 1] : undefined }));
      break;
    case 'uninstall':
      runCli(() => uninstall(String(rest[0] || '').toLowerCase(), INSTALL_FROM));
      break;
    case 'doctor':
      if (rest.includes('--json') && !rest.includes('--live')) runCli(() => JSON.stringify(capabilityMatrix(cliStore()), null, 2) + '\n');
      else if (rest.includes('--live')) {
        try { process.stdout.write(JSON.stringify(await liveProbe(rest[rest.indexOf('--live') + 1]), null, 2) + '\n'); }
        catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
      } else runCli(() => doctor(INSTALL_FROM));
      break;
    case 'run':
      try {
        const result = await runAgent(cliStore(), rest[0], rest.slice(1).filter((arg) => arg !== '--protected'), { protected: rest.includes('--protected') });
        process.exitCode = result.record.exitCode ?? 2;
      } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 2; }
      break;
    case 'prune':
      runCli(() => prune(rest[0], rest[1]));
      break;
    case 'rules': {
      const root = resolveRoot(process.cwd(), process.env.CLAUDE_PROJECT_DIR);
      const ask = process.stdin.isTTY && process.stdout.isTTY ? askYesNo : undefined;
      try {
        process.stdout.write(await runRules(root, { yes: rest.includes('--yes'), ask }));
      } catch (err) {
        process.stdout.write(`Keel could not finish: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
      break;
    }
    default:
      process.stdout.write([
        'Usage:',
        '  keel verify [--json] | status [--json|--pretty] | receipt [--json]',
        '  keel baseline approve --task <id> | apply <session> --dry-run',
        '  keel revert [-i|--files <paths>|--session <id>] [--dry-run] | revert undo | audit',
        '  keel tui | keel statusline | keel meter | keel learn [on|off] [here]',
        '  keel install <cursor|copilot|opencode|antigravity>   set Keel up for that agent (your user settings only)',
        '  keel uninstall <agent>                               remove only Keel\'s entries',
        '  keel doctor                                          show where Keel is installed and what it can do there',
        '  keel rules [--yes]                                   check that every agent reads the same rules (AGENTS.md)',
        '  keel hook <Event> [agent]                            used by the agents\' hooks',
      ].join('\n') + '\n');
      process.exitCode = command ? 1 : 0;
  }
}

// Run when started as a script or as the compiled executable; the Codex
// launcher imports this file and calls main().
if (COMPILED || (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)) {
  await main(process.argv.slice(2));
}

/** @param {string|undefined} hookName @param {string|undefined} agentName */
async function runHook(hookName, agentName) {
  /** @type {import('../src/shim.mjs').Adapter} */
  const adapter = ADAPTERS[agentName || 'claude-code'] || claudeCode;
  let out = null;
  try {
    const raw = await readStdin();
    /** @type {any} */
    let payload = {};
    try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = {}; }
    if (!payload || typeof payload !== 'object') payload = {};
    if (typeof payload.hook_event_name !== 'string' && hookName) payload.hook_event_name = hookName;
    out = processHook(adapter, payload, {
      pluginRoot: PLUGIN_ROOT,
      projectDir: adapter === claudeCode ? process.env.CLAUDE_PROJECT_DIR : null,
      edition: COMPILED ? 'compiled' : 'node',
    });
  } catch {
    out = adapter.fallback ? adapter.fallback(String(hookName)) : null;
  } finally {
    if (out) process.stdout.write(JSON.stringify(out));
    process.exitCode = 0;
  }
}

function cliStore() {
  return new ProjectStore(resolveRoot(process.cwd(), process.env.CLAUDE_PROJECT_DIR));
}

/** @param {() => string} fn */
function runCli(fn) {
  try {
    process.stdout.write(fn());
  } catch (err) {
    process.stdout.write(`Keel could not finish: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Deletes old checkpoints for a project (the session-start hook runs this in
 * the background once a day). keepSession is never pruned.
 * @param {string|undefined} rootArg @param {string|undefined} keepSession
 */
function prune(rootArg, keepSession) {
  const store = new ProjectStore(rootArg ? path.resolve(rootArg) : resolveRoot(process.cwd(), process.env.CLAUDE_PROJECT_DIR));
  const { checkpoints } = projectSettings(loadConfig(), store.root);
  const r = new Shadow(store).prune({ keepDays: checkpoints.keepDays, maxBytes: checkpoints.maxSizeMB * 1024 * 1024, keep: keepSession || null });
  const mb = (/** @type {number} */ n) => `${(n / 1048576).toFixed(1)} MB`;
  return `Keel removed the checkpoints of ${r.removed} old ${r.removed === 1 ? 'session' : 'sessions'}. The store went from ${mb(r.bytesBefore)} to ${mb(r.bytesAfter)}. The latest green checkpoint is always kept.\n`;
}

/** @param {ProjectStore} store */
function receipt(store) {
  const [current, ...earlier] = store.listSessions();
  if (!current) return 'Keel has no records for this project yet.\n';
  const events = store.readSession(current);
  const start = events.find((e) => e.kind === 'session_start');
  const settings = projectSettings(loadConfig(), store.root);
  const where = {
    currentStatus: currentStatus(store),
    storeDir: store.dir,
    finalTokens: start?.transcript ? usageFor(start.agent, start.transcript) : null,
    budgets: settings.budgets,
    budgetUnits: settings.budgetUnits,
    sandbox: start && settings.guard.mode === 'beginner' ? sandboxLine(start.agent, sandboxStatus(start.agent, { transcriptPath: start.transcript, root: store.root })) : null,
  };
  const now = catches(events);
  // At the start of a new session the notice points here for an earlier
  // session's catches, so include the latest one when this session is quiet.
  if (!now.claims && !now.loops) {
    for (const id of earlier.slice(0, 5)) {
      const before = store.readSession(id);
      const then = catches(before);
      if (then.claims || then.loops) {
        return `${renderReceipt(events, { ...where, storeDir: null })}\nYour previous session in this project:\n\n${renderReceipt(before, { storeDir: store.dir, budgets: where.budgets, budgetUnits: where.budgetUnits })}`;
      }
    }
  }
  return renderReceipt(events, where);
}

/**
 * Shows or changes the learning-notes setting.
 * @param {string[]} args  [on|off] [here], in any order.
 */
function learn(args) {
  const words = args.join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  const mode = words.includes('off') ? 'off' : words.includes('on') ? 'on' : null;
  const here = words.includes('here');
  const root = resolveRoot(process.cwd(), process.env.CLAUDE_PROJECT_DIR);
  if (mode) setLearnMode(mode, here ? root : null);
  const now = projectSettings(loadConfig(), root).learn.mode === 'off' ? 'off' : 'on';
  const lines = [];
  if (mode) {
    lines.push(`Keel learning notes are now ${mode} ${here ? `for this project (${root})` : 'for all your projects'}.`);
    if (!here && now !== mode) lines.push(`This project has its own setting, so they stay ${now} here. Run /keel:learn ${mode} here to change it.`);
  } else {
    lines.push(`Keel learning notes are ${now} in this project.`);
  }
  lines.push(now === 'on'
    ? 'On debugging turns, and when something new is added to the project, the agent adds a short explanation and asks you one question. Run /keel:learn off to stop this.'
    : 'Run /keel:learn on to get a short explanation and one question on debugging turns and when something new is added.');
  return lines.join('\n') + '\n';
}

/**
 * The current task's usage in one line, for a status line or a terminal.
 * Claude Code's status line passes session_id, transcript_path and cwd on stdin.
 */
async function meter() {
  try {
    let info = {};
    if (!process.stdin.isTTY) {
      const raw = await readStdin(500);
      process.stdin.destroy();
      try { info = raw.trim() ? JSON.parse(raw) : {}; } catch { info = {}; }
    }
    const cwd = info.workspace?.current_dir || info.cwd || process.cwd();
    const store = new ProjectStore(resolveRoot(cwd, info.workspace?.project_dir));
    const session = info.session_id || store.listSessions()[0];
    const events = session ? store.readSession(session) : [];
    const start = events.find((e) => e.kind === 'session_start');
    const agent = start?.agent || 'claude-code';
    const transcript = info.transcript_path || start?.transcript || null;
    const settings = projectSettings(loadConfig(), store.root);
    process.stdout.write(meterLine(budgetStatus(events, usageFor(agent, transcript), settings.budgets, settings.budgetUnits)) + '\n');
  } catch {
    process.stdout.write('Keel\n');
  }
}

/**
 * Renders the 1-line Claude Code / OpenCode statusline HUD (`keel statusline`).
 */
async function statusline() {
  try {
    let info = {};
    if (!process.stdin.isTTY) {
      const raw = await readStdin(500);
      process.stdin.destroy();
      try { info = raw.trim() ? JSON.parse(raw) : {}; } catch { info = {}; }
    }
    const cwd = info.workspace?.current_dir || info.cwd || process.cwd();
    const store = new ProjectStore(resolveRoot(cwd, info.workspace?.project_dir));
    process.stdout.write(renderStatusline(store, info) + '\n');
  } catch {
    process.stdout.write('⚓ keel\n');
  }
}

/** Asks a yes-or-no question in the terminal. @param {string} question */
async function askYesNo(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^\s*y(es)?\s*$/i.test(await rl.question(question));
  } finally {
    rl.close();
  }
}

/** A session's usage from its transcript, through the agent's own reader. @param {string} agent @param {string|null} transcript */
function usageFor(agent, transcript) {
  const adapter = ADAPTERS[agent];
  return adapter?.tokens ? adapter.tokens(transcript) : cumulativeUsage(agent, transcript);
}

/** @param {number} [timeoutMs] */
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = timeoutMs ? setTimeout(() => resolve(data), timeoutMs) : null;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { if (timer) clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => resolve(data));
  });
}
