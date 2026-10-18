// Keel's OpenCode plugin. `keel install opencode` writes a one-line file in
// ~/.config/opencode/plugins/ that re-exports KeelPlugin from here.
//
// Every hook passes a small payload through Keel's shim (src/shim.mjs), the
// same code the other agents use. Keel fails open: apart from the deliberate
// error that refuses a tool, nothing here may throw into OpenCode.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processHook } from '../src/shim.mjs';
import * as adapter from '../src/adapters/opencode.mjs';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {{client: any, directory?: string, worktree?: string}} input
 */
export const KeelPlugin = async ({ client, directory, worktree }) => {
  const root = worktree || directory || process.cwd();
  /** Guidance for each session's system prompt during the current prompt. */
  const guidance = new Map();
  /** Usage per assistant message, per session. */
  const usage = new Map();

  const tokens = (sessionID) => {
    const m = usage.get(sessionID);
    if (!m) return null;
    return [...m.values()].reduce((a, b) => ({ units: a.units + b.units, newTokens: a.newTokens + b.newTokens, output: a.output + b.output }), { units: 0, newTokens: 0, output: 0 });
  };
  const run = (payload) => processHook(adapter, { ...payload, root }, {
    pluginRoot: PLUGIN_ROOT,
    projectDir: root,
    cumulativeTokens: () => tokens(payload.sessionID),
  });
  const toast = async (message) => {
    try { await client?.tui?.showToast?.({ body: { title: 'Keel', message, variant: 'warning', duration: 10000 } }); } catch { /* the TUI may be absent */ }
  };

  return {
    'chat.message': async (input, output) => {
      try {
        const prompt = (output?.parts || []).filter((p) => p?.type === 'text' && !p.synthetic).map((p) => p.text).join('\n');
        const out = run({ hook_event_name: 'chat.message', sessionID: input?.sessionID, messageID: input?.messageID || output?.message?.id, prompt });
        if (out?.context) guidance.set(input.sessionID, out.context);
        else if (!/^\s*\[Keel\]/.test(prompt)) guidance.delete(input?.sessionID);
        if (out?.toast) await toast(out.toast);
      } catch { /* fail open */ }
    },

    'experimental.chat.system.transform': async (input, output) => {
      try {
        const text = guidance.get(input?.sessionID);
        if (text && Array.isArray(output?.system)) output.system.push(text);
      } catch { /* fail open */ }
    },

    'tool.execute.before': async (input, output) => {
      let out = null;
      try {
        out = run({ hook_event_name: 'tool.execute.before', sessionID: input?.sessionID, callID: input?.callID, tool: input?.tool, args: output?.args });
        if (out?.toast) await toast(out.toast);
      } catch { out = null; }
      // The one deliberate throw: OpenCode refuses the tool and shows the agent this reason.
      if (out?.deny) throw new Error(out.deny);
    },

    'tool.execute.after': async (input, output) => {
      try {
        const out = run({
          hook_event_name: 'tool.execute.after', sessionID: input?.sessionID, callID: input?.callID, tool: input?.tool,
          args: input?.args, output: output?.output, metadata: output?.metadata,
        });
        if (out?.append && output) output.output = `${output.output ?? ''}\n\n${out.append}`;
        if (out?.toast) await toast(out.toast);
      } catch { /* fail open */ }
    },

    event: async ({ event }) => {
      try {
        const props = event?.properties || {};
        if (event?.type === 'message.updated' && props.info?.role === 'assistant') {
          const m = usage.get(props.info.sessionID) || new Map();
          m.set(props.info.id, adapter.messageTokens(props.info));
          usage.set(props.info.sessionID, m);
          return;
        }
        if (event?.type === 'session.created' || event?.type === 'session.deleted') {
          const out = run({ hook_event_name: event.type, sessionID: props.info?.id });
          if (out?.toast) await toast(out.toast);
          return;
        }
        if (event?.type !== 'session.idle') return;
        const sessionID = props.sessionID;
        const lastMessage = await lastAssistantText(client, sessionID);
        const out = run({ hook_event_name: 'session.idle', sessionID, lastMessage });
        if (out?.toast) await toast(out.toast);
        if (out?.followUp) {
          await client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: out.followUp }] } });
        } else {
          guidance.delete(sessionID);
        }
      } catch { /* fail open */ }
    },
  };
};

/** The text of the session's latest assistant message, or null. */
async function lastAssistantText(client, sessionID) {
  try {
    const res = await client.session.messages({ path: { id: sessionID } });
    const list = Array.isArray(res) ? res : res?.data || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m?.info?.role !== 'assistant') continue;
      const text = (m.parts || []).filter((p) => p?.type === 'text' && !p.synthetic).map((p) => p.text).join('\n').trim();
      if (text) return text;
    }
  } catch { /* fall through */ }
  return null;
}

export default KeelPlugin;
