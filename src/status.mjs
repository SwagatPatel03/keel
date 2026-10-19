import { Shadow } from './checkpoint.mjs';
import path from 'node:path';
import { digest, readJson, keyFor } from './workspace.mjs';
import { loadConfig, projectSettings } from './store.mjs';
import { checkDefinitions, dependencyIdentity, evidenceIntegrity, confirmedCriteria } from './verification.mjs';

export function taskContext(store, requestedSession = null) {
  const session = requestedSession || store.listSessions()[0] || 'verification';
  const events = store.readSession(session);
  const start = [...events].reverse().find((e) => e.kind === 'turn_start');
  const checkedTask = [...events].reverse().find((e) => e.kind === 'verification')?.evidence?.task;
  return { session, task: start?.taskId || checkedTask || session + ':' + (start?.turn || 'manual'), turn: start?.turn || null, events };
}
export function status(store, requestedSession = null) {
  const { session, task, events } = taskContext(store, requestedSession);
  const last = [...events].reverse().find((e) => e.kind === 'turn_start' || e.kind === 'turn_end' || e.kind === 'verification' || e.kind === 'keel_error');
  const evidence = last?.evidence || last?.verification || null;
  const reasons = [...(evidence?.reasons || [])];
  const configuration = projectSettings(loadConfig(), store.root);
  let verdict = last?.v >= 2 ? last.verdict || evidence?.verdict || 'not_verified' : 'not_verified';
  if (configuration.configurationError) { verdict = 'not_verified'; reasons.push(configuration.configurationError); }
  if (last?.kind === 'keel_error') reasons.push('A hook failed; protection coverage is degraded.');
  if (verdict === 'verified' || verdict === 'failed') {
    try {
      const integrity = evidenceIntegrity(store, evidence);
      if (integrity.length) { verdict = 'not_verified'; reasons.push(...integrity); }
      const shadow = new Shadow(store).init();
      const now = shadow.snapshot(session, 'status-current');
      if (!now || shadow.git(['rev-parse', `${now}^{tree}`]).trim() !== shadow.git(['rev-parse', `${evidence.checkpoint}^{tree}`]).trim()) { verdict = 'not_verified'; reasons.push('Workspace changed since verification.'); }
      const baseline = readJson(path.join(store.dir, 'baselines', keyFor(evidence.task || task) + '.json'));
      if (evidence.identity && (baseline?.hash !== evidence.identity.baseline || dependencyIdentity(store.root, undefined, baseline?.checks || []) !== evidence.identity.dependencies)) { verdict = 'not_verified'; reasons.push('Trusted baseline or dependency contents changed.'); }
      const settings = projectSettings(loadConfig(), store.root);
      if (evidence.identity && (digest(checkDefinitions(store.root, settings)) !== evidence.identity.runnerConfiguration || digest(confirmedCriteria(store,evidence.task || task,settings,baseline)) !== evidence.identity.criteria)) { verdict = 'not_verified'; reasons.push('Verification configuration or acceptance criteria changed.'); }
    } catch { verdict = 'not_verified'; reasons.push('Current evidence identity unavailable.'); }
  }
  const checkpointAudit = readJson(path.join(store.dir, 'checkpoint-audit.json'));
  if (checkpointAudit?.quarantined) reasons.push('Legacy checkpoint store quarantined: run keel audit for paths and the explicit purge procedure.');
  if (!evidence) reasons.push('No current version 2 independent verification evidence.');
  const hooks = events.filter((e) => e.agent !== 'keel');
  return { v: 2, session, task, verdict, reasons, evidence, checkpointAudit, protection: evidence?.protection || { mode: 'plugin', enforcement: 'best_effort' }, coverage: { observed: [...new Set(hooks.map((e) => e.kind))], lastObserved: hooks.at(-1)?.t || null, liveTested: false, unavailable: ['An ordinary hook cannot detect its own total absence.'] }, boundaries: ['No general correctness or production-readiness certification.', 'Project checkpoints do not recover external databases or cloud resources.'] };
}
export function statusText(result) {
  return [`Verdict: ${result.verdict}`, ...result.reasons, ...((result.evidence?.checks || []).map((c) => `${c.id}: ${c.verdict}${c.counts ? `; ${c.counts.passed}/${c.counts.discovered} passed, ${c.counts.failed} failed, ${c.counts.skipped} skipped` : ''}`)), `Protection: ${result.protection.mode}; ${result.protection.enforcement}`, ...result.boundaries].join('\n') + '\n';
}
