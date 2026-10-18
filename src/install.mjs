// keel install / uninstall / doctor for agents that take hooks from settings
// files: Cursor, Copilot CLI, OpenCode and Antigravity. Keel writes only to the
// user's own settings in the home folder, never inside a project. Where an
// agent reads a folder of hook files, Keel writes its own file; where it must
// share a file, it merges its entries next to the user's, keeps a backup, and
// removes only its own entries on uninstall. (Claude Code and Codex install
// Keel as a plugin instead.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as cursor from './adapters/cursor.mjs';
import * as copilot from './adapters/copilot.mjs';
import * as opencode from './adapters/opencode.mjs';
import * as antigravity from './adapters/antigravity.mjs';
import * as claudeCode from './adapters/claude-code.mjs';
import * as codex from './adapters/codex.mjs';
import { keelHome } from './store.mjs';
import { exeName, noSpacePath } from './runtime.mjs';

export const INSTALLABLE = ['cursor', 'copilot', 'opencode', 'antigravity'];

// Agents whose payloads were recorded from a real session and whose adapter
// was checked live. The others are built from their documentation.
export const CHECKED_LIVE = new Set(['claude-code', 'codex', 'copilot', 'antigravity']);

const CAPS = { 'claude-code': claudeCode.CAPS, codex: codex.CAPS, cursor: cursor.CAPS, copilot: copilot.CAPS, opencode: opencode.CAPS, antigravity: antigravity.CAPS };
const NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', cursor: 'Cursor', copilot: 'Copilot CLI', opencode: 'OpenCode', antigravity: 'Antigravity' };

/**
 * exe is set when Keel runs as a compiled executable: hooks then run a copy of
 * it kept in Keel's home folder (binDir), because the plugin's own folder moves
 * when Claude Code updates the plugin.
 * @typedef {{home?: string, keelRoot: string, nodePath?: string, exe?: string, binDir?: string, env?: NodeJS.ProcessEnv, now?: () => Date}} InstallOptions
 */

/** Where each agent's user-level hook settings live. @param {string} agent @param {InstallOptions} o */
export function settingsFile(agent, o) {
  const home = o.home || os.homedir();
  const env = o.env || process.env;
  switch (agent) {
    case 'cursor': return path.join(home, '.cursor', 'hooks.json');
    case 'copilot': return path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'hooks', 'keel.json');
    case 'opencode': return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'plugins', 'keel.js');
    case 'antigravity': return path.join(home, '.gemini', 'config', 'hooks.json');
    default: throw new Error(`Keel cannot install into "${agent}". Choose one of: ${INSTALLABLE.join(', ')}.`);
  }
}

/** Keel's script path with forward slashes, which every shell and Node accept. @param {InstallOptions} o */
function keelScript(o) {
  return path.join(o.keelRoot, 'bin', 'keel.mjs').split(path.sep).join('/');
}

/** Where a compiled Keel keeps the copy that other agents' hooks run. @param {InstallOptions} o */
function installedExe(o) {
  return path.join(o.binDir || path.join(keelHome(), 'bin'), path.basename(o.exe || exeName()));
}

/**
 * Copies the running executable to its fixed place, unless it already runs
 * from there. A copy that is in use (an agent is running a hook) is kept.
 * @param {InstallOptions} o @returns {string} The executable's path for hooks, without spaces where possible.
 */
function placeExe(o) {
  const dest = installedExe(o);
  if (o.exe && path.resolve(o.exe) !== path.resolve(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      fs.copyFileSync(o.exe, dest);
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    } catch (err) {
      if (!fs.existsSync(dest)) throw err;
    }
  }
  return noSpacePath(dest).split(path.sep).join('/');
}

/**
 * The shell command for agents that run hooks through a shell. "node" is left
 * bare (found on PATH) because a quoted program path at the start does not run
 * in PowerShell; the script path is quoted because it may contain spaces. A
 * compiled Keel is given by a path without spaces where Windows has one.
 * @param {InstallOptions} o @param {string} event @param {string} agent
 */
function shellCommand(o, event, agent) {
  if (o.exe) {
    const exe = placeExe(o);
    return `${exe.includes(' ') ? `"${exe}"` : exe} hook ${event} ${agent}`;
  }
  return `node "${keelScript(o)}" hook ${event} ${agent}`;
}

/** Recognises a command Keel wrote, for re-install and uninstall. @param {unknown} command @param {string} agent */
function isKeelCommand(command, agent) {
  return typeof command === 'string' && /[\\/]keel(\.mjs|\.exe)?"? hook \w+/i.test(command) && command.trim().endsWith(` ${agent}`);
}

const CURSOR_EDIT_TOOLS = 'Write|Edit|StrReplace|MultiEdit|Delete|edit_file|write_file|search_replace|apply_patch';
const AGY_TOOLS = 'run_command|view_file|write_to_file|replace_file_content|multi_replace_file_content';

/** @param {InstallOptions} o */
function cursorEntries(o) {
  const entry = (event, extra = {}) => ({ command: shellCommand(o, event, 'cursor'), ...extra });
  return {
    sessionStart: [entry('sessionStart', { timeout: 30 })],
    beforeSubmitPrompt: [entry('beforeSubmitPrompt', { timeout: 30 })],
    beforeShellExecution: [entry('beforeShellExecution', { timeout: 30 })],
    beforeReadFile: [entry('beforeReadFile', { timeout: 30 })],
    preToolUse: [entry('preToolUse', { timeout: 30, matcher: CURSOR_EDIT_TOOLS })],
    postToolUse: [entry('postToolUse', { timeout: 30 })],
    postToolUseFailure: [entry('postToolUseFailure', { timeout: 30 })],
    afterAgentResponse: [entry('afterAgentResponse', { timeout: 30 })],
    stop: [entry('stop', { timeout: 180, loop_limit: 2 })],
    sessionEnd: [entry('sessionEnd', { timeout: 30 })],
  };
}

/** @param {InstallOptions} o */
function copilotFile(o) {
  const exec = o.exe ? placeExe(o) : o.nodePath || process.execPath;
  const lead = o.exe ? [] : [keelScript(o)];
  const entry = (event, timeoutSec = 30) => ({ type: 'command', exec, args: [...lead, 'hook', event, 'copilot'], timeoutSec });
  return {
    version: 1,
    hooks: {
      sessionStart: [entry('sessionStart')],
      userPromptSubmitted: [entry('userPromptSubmitted')],
      preToolUse: [entry('preToolUse')],
      postToolUse: [entry('postToolUse')],
      postToolUseFailure: [entry('postToolUseFailure')],
      agentStop: [entry('agentStop', 180)],
      sessionEnd: [entry('sessionEnd')],
    },
  };
}

/**
 * agy splits a hook command on spaces and keeps quote marks literally (seen
 * live on Windows), so the script is given as a file URL, which has no spaces.
 * @param {InstallOptions} o @param {string} event
 */
function importCommand(o, event, agent) {
  if (o.exe) {
    const exe = placeExe(o);
    if (exe.includes(' ')) throw new Error(`Antigravity cannot run a program whose path has a space in it, and Windows has no short name for ${exe}. Set KEEL_HOME to a folder without spaces, then run the install again.`);
    return `${exe} hook ${event} ${agent}`;
  }
  const url = pathToFileURL(path.join(o.keelRoot, 'bin', 'hook-import.mjs')).href;
  return `node --import=${url} -e 0 ${agent} ${event}`;
}

/** @param {InstallOptions} o */
function antigravityGroup(o) {
  const hook = (event, timeout = 30) => ({ type: 'command', command: importCommand(o, event, 'antigravity'), timeout });
  return {
    SessionStart: [hook('SessionStart')],
    PreInvocation: [hook('PreInvocation')],
    PreToolUse: [{ matcher: AGY_TOOLS, hooks: [hook('PreToolUse')] }],
    PostToolUse: [{ matcher: AGY_TOOLS, hooks: [hook('PostToolUse')] }],
    Stop: [hook('Stop', 180)],
  };
}

/** @param {InstallOptions} o */
function opencodeFile(o) {
  if (o.exe) throw new Error('OpenCode runs Keel\'s JavaScript itself, which the compiled Keel does not contain. Download Keel\'s source (git clone), then run node bin/keel.mjs install opencode from it. OpenCode then needs no Node.js, because it runs the plugin with its own runtime.');
  const url = pathToFileURL(path.join(o.keelRoot, 'opencode', 'plugin.mjs')).href;
  return `// Added by Keel (keel install opencode). Remove it with keel uninstall opencode.\nexport { KeelPlugin } from ${JSON.stringify(url)};\n`;
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return null;
    throw new Error(`Keel could not read ${file}, because it is not valid JSON. Fix or move that file, then run this again.`);
  }
}

/** Copies a file before Keel changes it. @param {string} file @param {InstallOptions} o */
function backup(file, o) {
  if (!fs.existsSync(file)) return null;
  const stamp = (o.now ? o.now() : new Date()).toISOString().replace(/[:.]/g, '-');
  const copy = `${file}.keel-backup-${stamp}`;
  fs.copyFileSync(file, copy);
  return copy;
}

/** @param {string} file @param {any} data */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Removes Keel's entries from Cursor's hooks object. @param {any} hooks */
function withoutKeelCursor(hooks) {
  const out = {};
  for (const [event, list] of Object.entries(hooks || {})) {
    const kept = (Array.isArray(list) ? list : []).filter((h) => !isKeelCommand(h?.command, 'cursor'));
    if (kept.length) out[event] = kept;
  }
  return out;
}

/**
 * Checks that the tools Keel's hooks need are there.
 * @param {string} agent @param {InstallOptions} o @returns {string[]} Problems, in plain words.
 */
export function preflight(agent, o) {
  const problems = [];
  if (o.exe) {
    if (!fs.existsSync(o.exe)) problems.push(`Keel's program was not found at ${o.exe}.`);
  } else {
    const node = o.nodePath || process.execPath;
    const version = spawnSync(node, ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) problems.push(`Node.js did not run from ${node}.`);
  }
  if (!o.exe && (agent === 'cursor' || agent === 'antigravity')) {
    const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', env: o.env || process.env });
    if (found.status !== 0) problems.push(`${NAMES[agent]} runs "node" from your PATH, and no node was found on your PATH.`);
  }
  const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
  if (git.status !== 0) problems.push('git did not run. Keel needs git on your PATH for checkpoints.');
  return problems;
}

/**
 * @param {string} agent @param {InstallOptions} o
 * @returns {string} What Keel did, in plain words.
 */
export function install(agent, o) {
  const file = settingsFile(agent, o);
  const problems = preflight(agent, o);
  if (problems.length) {
    return [`Keel did not install into ${NAMES[agent]}, because:`, ...problems.map((p) => `  - ${p}`), 'Fix this, then run the install again.'].join('\n') + '\n';
  }
  let saved = null;
  if (agent === 'cursor') {
    const current = readJson(file) || {};
    saved = backup(file, o);
    const hooks = withoutKeelCursor(current.hooks);
    for (const [event, list] of Object.entries(cursorEntries(o))) hooks[event] = [...(hooks[event] || []), ...list];
    writeJson(file, { ...current, version: current.version || 1, hooks });
  } else if (agent === 'antigravity') {
    const current = readJson(file) || {};
    const group = antigravityGroup(o);
    saved = backup(file, o);
    writeJson(file, { ...current, keel: group });
  } else if (agent === 'copilot') {
    writeJson(file, copilotFile(o));
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, opencodeFile(o));
  }
  const lines = [`Keel is now installed for ${NAMES[agent]} in all your projects. It wrote ${file}.`];
  if (saved) lines.push(`Your previous file is saved as ${saved}.`);
  if (agent === 'cursor') lines.push('Restart Cursor so it loads the new hooks.');
  if (agent === 'copilot') lines.push('Start a new Copilot CLI session to load the hooks.');
  if (agent === 'opencode') lines.push('Restart OpenCode so it loads the plugin.');
  if (agent === 'antigravity') lines.push('Restart Antigravity, then check that Keel is listed with /hooks (CLI) or under Customizations > Hooks.');
  if (!CHECKED_LIVE.has(agent)) lines.push(`Keel's ${NAMES[agent]} support is built from ${NAMES[agent]}'s documentation and has not been checked in a real session yet. If something looks wrong, run keel uninstall ${agent}.`);
  return lines.join('\n') + '\n';
}

/**
 * @param {string} agent @param {InstallOptions} o
 * @returns {string}
 */
export function uninstall(agent, o) {
  const file = settingsFile(agent, o);
  if (!fs.existsSync(file)) return `Keel is not installed for ${NAMES[agent]} (${file} does not exist).\n`;
  if (agent === 'cursor') {
    const current = readJson(file) || {};
    const hooks = withoutKeelCursor(current.hooks);
    writeJson(file, { ...current, hooks });
  } else if (agent === 'antigravity') {
    const current = readJson(file) || {};
    delete current.keel;
    writeJson(file, current);
  } else {
    fs.rmSync(file, { force: true });
  }
  return `Keel is no longer installed for ${NAMES[agent]}. It removed only its own entries${agent === 'cursor' || agent === 'antigravity' ? ` from ${file}` : ` (${file})`}. Keel's records in ~/.keel are kept; delete that folder to remove them.\n`;
}

/** Whether Keel's entries are present for an agent. @param {string} agent @param {InstallOptions} o */
export function isInstalled(agent, o) {
  const file = settingsFile(agent, o);
  try {
    if (agent === 'cursor') return Object.values(readJson(file)?.hooks || {}).some((list) => Array.isArray(list) && list.some((h) => isKeelCommand(h?.command, 'cursor')));
    if (agent === 'antigravity') return !!readJson(file)?.keel;
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

/**
 * Which agents have Keel, and what Keel can do in each.
 * @param {InstallOptions} o
 */
export function doctor(o) {
  const lines = ['Keel doctor', '', o.exe
    ? `This Keel: the compiled edition (${o.exe}). Other agents' hooks run its copy at ${installedExe(o)}.`
    : `This Keel: the Node.js edition (${o.keelRoot}).`, ''];
  for (const agent of ['claude-code', 'codex', ...INSTALLABLE]) {
    const caps = CAPS[agent];
    const status = INSTALLABLE.includes(agent)
      ? (isInstalled(agent, o) ? `installed (${settingsFile(agent, o)})` : `not installed; run keel install ${agent}`)
      : 'installed as a plugin from the agent itself';
    lines.push(`${NAMES[agent]}: ${status}`);
    lines.push(`  Checked in a real session: ${CHECKED_LIVE.has(agent) ? 'yes' : 'not yet (built from documentation)'}`);
    lines.push(`  Dangerous commands: ${caps.ask ? 'Keel asks you first' : 'Keel pauses them and tells the agent to ask you'}`);
    lines.push(`  Plan-first, clarity and learning guidance: ${caps.promptContext ? 'added when your prompt arrives' : 'added with the first tool result of the prompt'}`);
    lines.push(`  Budget warnings and notices: ${caps.userNotice ? 'shown to you' : 'kept in the receipt (this agent cannot show them)'}`);
    lines.push(`  Loop stops: ${caps.batchHook ? 'the agent is stopped' : 'further tool calls are refused until your next message'}`);
    if (agent === 'opencode') lines.push('  Known gap: OpenCode does not show Keel the tool calls of sub-agents started with its task tool (OpenCode issue #5894), so Keel cannot guard those.');
    if (agent === 'copilot') lines.push('  Sub-agents: their commands are guarded, but their prompts are not sized and their stops are not checked.');
  }
  const problems = preflight('cursor', o);
  lines.push('');
  lines.push(problems.length ? `Problems found:\n${problems.map((p) => `  - ${p}`).join('\n')}` : o.exe ? 'Keel\'s program is in place and git runs.' : 'Node.js and git both run.');
  return lines.join('\n') + '\n';
}
