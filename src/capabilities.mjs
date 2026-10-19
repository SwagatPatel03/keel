import path from 'node:path';
import { keelHome } from './store.mjs';
import { readJson } from './workspace.mjs';
import { VERSION, CAPABILITY_VERSION } from './version.mjs';
import { INSTALLABLE, isInstalled, settingsFile } from './install.mjs';

export function capabilityMatrix(store) {
  const observations = store.listSessions().flatMap((session) => store.readSession(session));
  const historical = { 'claude-code': '2.1.291', codex: '0.161.0', copilot: '1.0.98', antigravity: 'agy 1.4.2' };
  return {
    v: CAPABILITY_VERSION, keelVersion: VERSION, platform: process.platform, arch: process.arch,
    agents: ['claude-code', 'codex', 'copilot', 'opencode', 'antigravity', 'cursor'].map((agent) => {
      const events = observations.filter((event) => event.agent === agent);
      const probe = readJson(path.join(keelHome(), 'live-probes', `${agent}-${process.platform}-${process.arch}.json`));
      const options = {keelRoot:''};
      const configured = INSTALLABLE.includes(agent) ? { entriesPresent:isInstalled(agent,options), path:settingsFile(agent,options), activation:'unconfirmed' } : { entriesPresent:null, activation:'unconfirmed', reason:'Plugin activation is managed by the host agent.' };
      return { agent, adapterAvailable: true, configured, observed: [...new Set(events.map((event) => event.kind))], lastObserved: events.at(-1)?.t || null, historicalRecordedVersion: historical[agent] || null, liveTested: probe?.liveTested ? { version: probe.version, platform: probe.platform, arch: probe.arch, testedAt: probe.testedAt, supervision: probe.supervision } : null, externallyEnforced: false, pluginProtection: 'best_effort', protectedLaunch: { available: false, reason: 'Stage 3 operational sandbox backend and live isolation/recovery gate are unfinished.' }, gaps: ['A hook cannot detect its own total absence.', 'Subagent coverage needs version-specific live observations.'] };
    }),
  };
}
