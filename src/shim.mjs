// One hook call, from an agent's payload to that agent's output. bin/keel.mjs
// uses it for agents that run hooks as commands; the OpenCode plugin calls it
// directly inside OpenCode. It never throws: when Keel fails, the agent gets
// the adapter's fail-open output (usually nothing).

import { ProjectStore, resolveRoot } from './store.mjs';
import { handle } from './handlers.mjs';
import { cumulativeUsage } from './budget.mjs';

/**
 * @typedef {object} Adapter
 * @property {import('./agents.mjs').Caps} CAPS
 * @property {Set<string>} HALT_EVENTS
 * @property {(payload: any, root: string) => any} toEvent
 * @property {(decision: any, hookEvent: string) => any} render
 * @property {(transcriptPath: string|null, root?: string|null) => string|string[]|null} plansDir
 * @property {(payload: any) => HookInfo} [info]
 * @property {(hookEvent: string) => any} [fallback]  Output when Keel has nothing to say or fails.
 * @property {(transcriptPath: string|null) => import("./budget.mjs").Usage|null} [tokens]
 * @property {(payload: any, events: any[]) => any[]} [amend]  tool_result_amend events for results that were pending.
 *
 * @typedef {{prompt: string|null, toolInput: any, lastMessage: string|null, transcriptPath: string|null, projectDir?: string|null, cwd?: string|null}} HookInfo
 */

/** The fields Claude Code and Codex payloads share. @param {any} p @returns {HookInfo} */
export function defaultInfo(p) {
  return {
    prompt: typeof p.prompt === 'string' ? p.prompt : null,
    toolInput: p.tool_input ?? null,
    lastMessage: p.last_assistant_message ?? null,
    transcriptPath: p.transcript_path || null,
    cwd: p.cwd || null,
  };
}

/**
 * @param {Adapter} adapter
 * @param {any} payload  The agent's hook JSON, with hook_event_name set (an object).
 * @param {{pluginRoot: string, projectDir?: string|null, cumulativeTokens?: () => import("./budget.mjs").Usage|null, edition?: 'node'|'compiled'}} opts
 * @returns {any}  The agent's output object, or null for no output.
 */
export function processHook(adapter, payload, opts) {
  const hookEvent = payload.hook_event_name;
  const fallback = () => (adapter.fallback ? adapter.fallback(hookEvent) : null);
  let store = null;
  try {
    const info = adapter.info ? adapter.info(payload) : defaultInfo(payload);
    const root = resolveRoot(info.cwd || process.cwd(), info.projectDir || opts.projectDir || undefined);
    store = new ProjectStore(root);
    const event = adapter.toEvent(payload, root);
    if (!event) return fallback();
    // Which Keel is running, so two installed Keel plugins can be noticed.
    if (event.kind === 'session_start' && opts.edition) event.edition = opts.edition;

    // Outcomes the agent reported late (Antigravity) are filled in first.
    if (adapter.amend) {
      for (const a of adapter.amend(payload, store.readSession(event.session)) || []) store.append(a);
    }

    // Agents that report the final message in a separate hook (Cursor's
    // afterAgentResponse): keep the latest one until the turn ends, then delete it.
    if (event.kind === 'agent_message') {
      if (info.lastMessage) store.saveLastMessage(event.session, info.lastMessage);
      return fallback();
    }
    let lastMessage = info.lastMessage;
    if (event.kind === 'turn_end' && lastMessage == null) lastMessage = store.takeLastMessage(event.session);

    const transcriptPath = info.transcriptPath;
    const decision = handle(event, {
      store,
      caps: adapter.CAPS,
      transcriptPath,
      lastMessage,
      haltWorks: adapter.HALT_EVENTS.has(hookEvent),
      prompt: info.prompt,
      toolInput: info.toolInput,
      pluginRoot: opts.pluginRoot,
      plansDir: adapter.plansDir(transcriptPath, root),
      cumulativeTokens: opts.cumulativeTokens
        || (adapter.tokens ? () => adapter.tokens?.(transcriptPath) ?? null : () => cumulativeUsage(adapter.CAPS.name, transcriptPath)),
    });
    const out = adapter.render(decision, hookEvent);
    return out ?? fallback();
  } catch (err) {
    store?.logError(err, `hook ${hookEvent}`);
    return fallback();
  }
}
