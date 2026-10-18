// The agents Keel supports and what their hooks can do. Every adapter exports
// CAPS built from these flags; handlers read only the flags, never agent names.
//
//   batchHook      a hook runs between tool batches, so a loop stop can be delivered there
//   ask            a pre-tool hook can make the agent ask the user
//   planTool       the agent has a plan-approval step (Claude Code's ExitPlanMode)
//   promptContext  the prompt hook can add text to the agent's context
//   userNotice     a hook can show the user a message that the user will see

/** @typedef {{name: string, batchHook: boolean, ask: boolean, planTool: boolean, promptContext: boolean, userNotice: boolean}} Caps */

const NAMES = {
  'claude-code': 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
};

/** The agent's name as the user knows it. @param {string|null|undefined} agent */
export function displayName(agent) {
  return NAMES[String(agent)] || 'the agent';
}

/**
 * Keel's messages are written about Claude; other agents get their own name.
 * "Claude Code" (the product) is left alone.
 * @param {string} text @param {string|null|undefined} agent
 */
export function renameFor(text, agent) {
  if (typeof text !== 'string' || !agent || agent === 'claude-code') return text;
  return text.replace(/\bClaude\b(?! Code)/g, displayName(agent));
}
