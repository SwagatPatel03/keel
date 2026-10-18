// Canonical, agent-neutral events. Every adapter (Claude Code now; Codex,
// Cursor and others later) turns its own hook payloads into these shapes, and
// every Keel feature reads only these shapes.
//
// Changing a field here is expensive: stored session logs use this format.
// Add fields freely; rename or remove them only together with a bump of
// EVENT_VERSION and a reader for the old version.

export const EVENT_VERSION = 1;

/**
 * @typedef {'session_start'|'turn_start'|'tool_call'|'tool_result'|'batch_end'|'plan_ready'|'plan_check'|'guard'|'budget'|'turn_end'|'loop'|'halt_delivered'|'learn'|'guidance'|'agent_message'|'sent_back'|'tool_result_amend'|'budget_stop'|'session_end'|'keel_error'} EventKind
 *
 * @typedef {object} BaseEvent
 * @property {number} v           Event format version.
 * @property {string} t           ISO timestamp.
 * @property {string} agent       Which agent produced it, e.g. "claude-code".
 * @property {string} session     Agent session id.
 * @property {string|null} turn   Id of the user turn (prompt) this belongs to.
 * @property {EventKind} kind
 *
 * @typedef {object} ToolResult
 * @property {string} tool              Tool name as the agent reports it.
 * @property {string|null} toolUseId
 * @property {boolean} ok               False when the tool failed (non-zero exit, tool error).
 * @property {number|null} exitCode     Shell exit code when known.
 * @property {string|null} command      Shell command (redacted, shortened), for shell tools.
 * @property {boolean} isTest           The command runs tests.
 * @property {boolean} isBuild          The command builds, type-checks or lints.
 * @property {string[]} files           Project-relative paths the tool wrote.
 * @property {string|null} fileHash     Content hash of the written file after the tool ran.
 * @property {string|null} originalHash Content hash of the file before the tool ran, when known.
 * @property {string|null} errorExcerpt Short redacted error text.
 * @property {string|null} errorFingerprint Hash of the normalised error, for loop detection.
 * @property {string|null} commandKey   Hash of the normalised command, for loop resets.
 */

/**
 * @param {EventKind} kind
 * @param {{agent: string, session: string, turn?: string|null}} ctx
 * @param {object} [fields]
 */
export function makeEvent(kind, ctx, fields = {}) {
  return {
    v: EVENT_VERSION,
    t: new Date().toISOString(),
    agent: ctx.agent,
    session: ctx.session,
    turn: ctx.turn ?? null,
    kind,
    ...fields,
  };
}

/** The tools that write files, across agents. */
export const FILE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch', 'edit_file', 'write_file']);

/** The tools that run shell commands, across agents. */
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'shell', 'run_terminal_cmd', 'exec_command']);
