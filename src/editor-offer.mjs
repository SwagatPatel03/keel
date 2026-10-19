// When Keel runs inside VS Code or Cursor and the Keel extension is not
// installed, the first session says once where to get it. A marker in Keel's
// home stops repeats, whatever the person decides.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keelHome } from './store.mjs';

export const EXTENSION_ID = 'swagatpatel.keel';

/**
 * Which editor the agent runs in, from the variables the editor sets for its
 * terminals and for Claude Code's VS Code extension.
 * @param {NodeJS.ProcessEnv} env @returns {'vscode'|'cursor'|null}
 */
export function editorFrom(env) {
  const inEditor = env.CLAUDE_CODE_ENTRYPOINT === 'claude-vscode' || env.TERM_PROGRAM === 'vscode' || Boolean(env.VSCODE_PID || env.VSCODE_IPC_HOOK || env.VSCODE_IPC_HOOK_CLI);
  if (!inEditor) return null;
  const hints = [env.CURSOR_TRACE_ID ? 'cursor' : '', env.VSCODE_GIT_ASKPASS_NODE, env.VSCODE_CWD, env.VSCODE_IPC_HOOK_CLI, env.VSCODE_IPC_HOOK].join(' ').toLowerCase();
  return /cursor/.test(hints) ? 'cursor' : 'vscode';
}

/** Whether any VS Code-family editor on this machine has the extension. @param {string} home */
export function extensionInstalled(home) {
  for (const dir of ['.vscode', '.vscode-insiders', '.cursor', '.vscode-server', '.windsurf'].map((d) => path.join(home, d, 'extensions'))) {
    try {
      if (fs.readdirSync(dir).some((name) => name.toLowerCase().startsWith(`${EXTENSION_ID}-`))) return true;
    } catch { /* that editor is not installed */ }
  }
  return false;
}

/**
 * The one-time offer, or null.
 * @param {{ env?: NodeJS.ProcessEnv, home?: string }} [o]
 */
export function editorOffer(o = {}) {
  const editor = editorFrom(o.env || process.env);
  if (!editor || extensionInstalled(o.home || os.homedir())) return null;
  const marker = path.join(keelHome(), 'editor-offer-shown');
  if (fs.existsSync(marker)) return null;
  try { fs.mkdirSync(keelHome(), { recursive: true }); fs.writeFileSync(marker, new Date().toISOString()); } catch { return null; }
  const name = editor === 'cursor' ? 'Cursor' : 'VS Code';
  const cli = editor === 'cursor' ? 'cursor' : 'code';
  return `Keel: you can see Keel's verdict, the task budget and every changed file in ${name}'s sidebar. Install the Keel extension by searching for "Keel for Claude Code" in the Extensions view, or run: ${cli} --install-extension ${EXTENSION_ID}. Keel shows this message once.`;
}
