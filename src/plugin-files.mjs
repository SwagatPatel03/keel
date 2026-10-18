// Claude Code plugin files that are generated rather than written by hand, so
// the Node.js plugin and the compiled platform plugins run the same hooks, and
// the Read filter stays in step with the guard's secret-file list.
// `node scripts/plugin-files.mjs` rewrites hooks/hooks.json from this module,
// and scripts/build-binaries.mjs uses it for each platform plugin.

import { READ_GUARD_GLOBS } from './guard/paths.mjs';

/**
 * How a hook starts Keel: the executable and the arguments before the event.
 * @typedef {{command: string, args: string[]}} Launcher
 */

/** The Node.js plugin: node runs bin/keel.mjs. */
export const NODE_LAUNCHER = { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/keel.mjs'] };

/** A platform plugin: the compiled executable, inside the plugin. @param {string} exe e.g. bin/keel.exe */
export function binaryLauncher(exe) {
  return { command: `\${CLAUDE_PLUGIN_ROOT}/${exe}`, args: [] };
}

/** Tools whose results Keel never needs, so PostToolUse skips them. */
const UNUSED_RESULTS = '^(?!(Read|Glob|Grep)$)';
const GUARDED_TOOLS = 'Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|ExitPlanMode';

/** @param {Launcher} launcher */
export function claudeHooks(launcher) {
  /** @param {string} event @param {number} [timeout] @param {string} [cond] */
  const hook = (event, timeout, cond) => ({
    type: 'command',
    command: launcher.command,
    args: [...launcher.args, 'hook', event],
    ...(cond ? { if: cond } : {}),
    ...(timeout ? { timeout } : {}),
  });
  return {
    description: 'Keel: task sizer, clarity check, plan check, command guard, protected paths, token budget, evidence gate, loop breaker, per-turn checkpoints and session receipt. Every hook prints nothing on normal turns, so it adds no tokens. Reads start Keel only for secret files.',
    hooks: {
      SessionStart: [{ hooks: [hook('SessionStart', 10)] }],
      UserPromptSubmit: [{ hooks: [hook('UserPromptSubmit', 30)] }],
      PreToolUse: [
        { matcher: GUARDED_TOOLS, hooks: [hook('PreToolUse', 15)] },
        // One handler per pattern: an `if` holds exactly one permission rule.
        { matcher: 'Read', hooks: READ_GUARD_GLOBS.map((g) => hook('PreToolUse', 15, `Read(//**/${g})`)) },
      ],
      PostToolUse: [{ matcher: UNUSED_RESULTS, hooks: [hook('PostToolUse', 15)] }],
      PostToolUseFailure: [{ hooks: [hook('PostToolUseFailure', 15)] }],
      PostToolBatch: [{ hooks: [hook('PostToolBatch', 15)] }],
      Stop: [{ hooks: [hook('Stop', 180)] }],
      SessionEnd: [{ hooks: [hook('SessionEnd')] }],
    },
  };
}

/** The file text, as written to hooks/hooks.json. @param {Launcher} launcher */
export function claudeHooksText(launcher) {
  return `${JSON.stringify(claudeHooks(launcher), null, 2)}\n`;
}
