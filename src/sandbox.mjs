// Whether the agent's own sandbox was on. Keel's guard reads each command
// before it runs, but it cannot see what a script does once it runs; the
// agent's sandbox limits that. The receipt says which it was, in beginner mode.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code: "on" or "off" from sandbox.enabled in the project's and the
 * user's settings (project settings win). Codex: the sandbox policy type its
 * session file records, such as "workspace-write". Other agents: null.
 * @param {string} agent
 * @param {{transcriptPath?: string|null, root?: string|null}} where
 * @returns {string|null}
 */
export function sandboxStatus(agent, { transcriptPath = null, root = null }) {
  if (agent === 'claude-code') {
    const config = transcriptPath
      ? path.dirname(path.dirname(path.dirname(transcriptPath)))
      : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const files = [
      ...(root ? [path.join(root, '.claude', 'settings.local.json'), path.join(root, '.claude', 'settings.json')] : []),
      path.join(config, 'settings.json'),
    ];
    for (const file of files) {
      let enabled;
      try { enabled = JSON.parse(fs.readFileSync(file, 'utf8'))?.sandbox?.enabled; } catch { continue; }
      if (typeof enabled === 'boolean') return enabled ? 'on' : 'off';
    }
    return 'off';
  }
  if (agent === 'codex') {
    let text;
    try { text = fs.readFileSync(String(transcriptPath), 'utf8'); } catch { return null; }
    const all = [...text.matchAll(/"sandbox_policy":\{"type":"([\w-]+)"/g)];
    return all.length ? all[all.length - 1][1] : null;
  }
  return null;
}

/**
 * The receipt line, or null when there is nothing useful to say.
 * @param {string} agent @param {string|null} status
 */
export function sandboxLine(agent, status) {
  if (!status) return null;
  const why = 'Keel reads each command before it runs, but it cannot see what a script does once it is running; the sandbox limits that.';
  if (agent === 'claude-code') {
    return status === 'on'
      ? 'Claude Code\'s own sandbox was on, so commands could only change files in this project.'
      : `Claude Code's own sandbox was off. ${why} Run /sandbox in Claude Code to turn it on.`;
  }
  if (agent === 'codex') {
    if (status === 'danger-full-access') return `Codex ran with no sandbox (danger-full-access). ${why} Start Codex without that setting to keep it.`;
    return `Codex ran in its ${status} sandbox.`;
  }
  return null;
}
