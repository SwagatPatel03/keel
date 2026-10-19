// The values Keel's interface module (hooks/keel-ui.tsx) keeps for a session.

export type KeelVerdict = 'verified' | 'failed' | 'not_verified';

/** What `keel ui --json` prints (src/ui-model.mjs). */
export type KeelModel = {
  v: 1;
  project: { name: string; root: string };
  store?: { dir: string; shadow: string; base: string | null };
  session: string | null;
  prompts: number;
  verdict: {
    value: KeelVerdict;
    reasons: string[];
    checks: { id: string; verdict: string; passed: number | null; total: number | null; failed: number | null; skipped: number | null }[];
    at: string | null;
    source: 'turn' | 'verify' | null;
  };
  task: { prompt: number; size: string; fraction: number; used: number; budget: number; unit: string; newTokens: number | null } | null;
  lastGreen: { prompt: number | null; at: string } | null;
  timeline: { prompt: number | null; at: string | null; kind: 'green' | 'failed' | 'blocked' | 'done'; files: number; summary: string }[];
  changes: { path: string; status: 'A' | 'M' | 'D'; added: number; removed: number }[];
  guard: { mode: string; refused: number; asked: number; recent: { decision: 'refuse' | 'ask'; rule: string; what: string; at: string | null }[] };
  catches: { claims: number; loops: number };
  learn: string;
};

/** Which page the Keel pane shows. */
export type KeelView = 'overview' | 'undo-preview' | 'undo-done' | 'receipt' | 'checks';

declare module 'claude-code' {
  interface PluginState {
    keel: {
      model: KeelModel | null;
      bandHidden: boolean;
      view: KeelView;
      output: string | null;
      busy: string | null;
    };
  }
}
