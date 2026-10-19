import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { NODE_REPORTER } from './node-reporter.mjs';
import { Shadow } from './checkpoint.mjs';
import { makeEvent } from './events.mjs';
import { isTestFile, findTestTampering } from './testdiff.mjs';
import { relativeFile, isSensitivePath, within } from './policy.mjs';
import { digest, keyFor, atomicJson, readJson, exportSnapshot, manifest, checkManifest, blob } from './workspace.mjs';
import { parseReport } from './reports.mjs';
import {parsePlanCriteria} from './criteria.mjs';

const baselineFile = (store, task) => path.join(store.dir, 'baselines', `${keyFor(task)}.json`);
const acceptanceFile = (store, task, criterion) => path.join(store.dir, 'acceptance', `${keyFor(task + ':' + criterion)}.json`);
const planCriteriaFile=(store,task)=>path.join(store.dir,'plan-criteria',keyFor(task)+'.json');

export function confirmedCriteria(store,task,settings={},baseline=readJson(baselineFile(store,task))) {
  const pending=readJson(planCriteriaFile(store,task));
  if(pending && pending.state!=='bound') throw new Error(pending.reason || 'Plan acceptance criteria await a matching host approval.');
  if(baseline?.criteriaSource==='approved_plan' && digest(settings.criteria || [])===baseline.configuredCriteriaHash) return baseline.criteria;
  return settings.criteria || [];
}
export function stagePlanCriteria(store,task,plan,toolUseId) {
  const baseline=readJson(baselineFile(store,task));
  let criteria;
  try { criteria=parsePlanCriteria(plan); }
  catch(error) { atomicJson(planCriteriaFile(store,task),{v:2,state:'invalid',reason:error.message});return; }
  if(!criteria && baseline?.criteriaSource!=='approved_plan') return;
  const proposal={v:2,state:'awaiting_approval',task,toolUseId,planHash:digest(plan),criteriaHash:digest(criteria),createdAt:new Date().toISOString()};
  atomicJson(planCriteriaFile(store,task),proposal);
}
export function bindApprovedPlanCriteria(store,task,plan,toolUseId,settings={}) {
  const file=planCriteriaFile(store,task),pending=readJson(file);
  if(!pending) return false;
  const baseline=readJson(baselineFile(store,task));
  try {
    const criteria=parsePlanCriteria(plan);
    if(!baseline || !toolUseId || pending.state!=='awaiting_approval' || pending.toolUseId!==toolUseId || pending.planHash!==digest(plan) || !criteria || pending.criteriaHash!==digest(criteria)) throw new Error('Approved plan criteria do not match the displayed proposal; review the plan again.');
    if(digest(settings.criteria || [])!== (baseline.configuredCriteriaHash || digest(baseline.criteria))) throw new Error('Configured criteria changed before plan approval; baseline approval is required.');
    const merged=[...(settings.criteria || [])];
    for(const criterion of criteria) {
      const existing=merged.find((item)=>item.id===criterion.id);
      if(existing && digest(existing)!==digest(criterion)) throw new Error('Plan criterion conflicts with a configured criterion.');
      if(!existing) merged.push(criterion);
    }
    for(const criterion of merged) if(criterion.check && !baseline.checks.some((check)=>check.id===criterion.check)) throw new Error('Plan criterion references an unconfigured check: '+criterion.check);
    const next={...baseline,criteria:merged,criteriaSource:'approved_plan',configuredCriteriaHash:digest(settings.criteria || []),criteriaApproval:{planHash:pending.planHash,toolUseId,approvedAt:new Date().toISOString(),origin:'host-approval-hook',enforcement:'best_effort'}};
    delete next.hash; const inventory=next.inventory;delete next.inventory;next.hash=digest(next);if(inventory)next.inventory=inventory;
    atomicJson(baselineFile(store,task),next);
    atomicJson(file,{...pending,state:'bound',baseline:next.hash,boundAt:new Date().toISOString()});
    return true;
  } catch(error) {atomicJson(file,{...pending,state:'invalid',reason:error.message});return false;}
}
const trustedFile = (file) => isTestFile(file) || /(^|\/)(__snapshots__|fixtures?|testdata)(\/|$)|(^|\/)(package\.json|.*lock.*|go\.(mod|sum)|pyproject\.toml|pytest\.ini|conftest\.py|requirements[^/]*|setup\.cfg|tox\.ini|\.babelrc[^/]*|\.swcrc|(?:vite|babel|swc)\.config[^/]*|[a-z]*test[^/]*config[^/]*|jest[^/]*|vitest[^/]*|tsconfig[^/]*)$/i.test(file);

function testDefinitions(root, settings = {}) {
  if (Array.isArray(settings.checks)) return settings.checks;
  // Compatibility inputs are never interpreted as evidence from arbitrary shell text.
  let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  const script = settings.testCommand || pkg?.scripts?.test || '';
  const args = script.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, '')) || [];
  if (args[0] === 'node' && args.includes('--test') && !/[;&|<>`$]/.test(script)) return [{ id: 'project', executable: 'node', args: args.slice(1), cwd: '.', format: 'node-events', scope: 'full', outputDirs: [] }];
  if (/^jest(?:\s|$)/.test(script) && !/[;&|<>`$]/.test(script)) return [{ id: 'project', executable: 'node', args: ['node_modules/jest/bin/jest.js', ...args.slice(1), '--json', '--outputFile={report}', '--runInBand'], cwd: '.', format: 'jest', scope: 'full', outputDirs: [] }];
  if (/^vitest(?:\s|$)/.test(script) && !/[;&|<>`$]/.test(script)) return [{ id: 'project', executable: 'node', args: ['node_modules/vitest/vitest.mjs', 'run', ...args.slice(1).filter((a) => a !== 'run'), '--reporter=json', '--outputFile={report}'], cwd: '.', format: 'vitest', scope: 'full', outputDirs: [] }];
  if (fs.existsSync(path.join(root, 'go.mod'))) return [{ id: 'project', executable: 'go', args: ['test', '-json', './...'], cwd: '.', format: 'go', scope: 'full', outputDirs: [] }];
  if (['pytest.ini', 'pyproject.toml', 'conftest.py'].some((file) => fs.existsSync(path.join(root, file)))) return [{ id: 'project', executable: 'python', args: ['-m', 'pytest', '--junitxml={report}'], cwd: '.', format: 'pytest', scope: 'full', outputDirs: [] }];
  return [];
}

export function validateVerificationSettings(settings) {
  const timeout = settings.checkTimeoutSec ?? 120;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) throw new Error('Verification timeout must be a positive finite number.');
  if (settings.checks !== undefined && !Array.isArray(settings.checks)) throw new Error('Structured checks must be an array.');
  if (settings.criteria !== undefined && !Array.isArray(settings.criteria)) throw new Error('Acceptance criteria must be an array.');
  for (const list of [settings.checks || [], settings.criteria || []]) {
    const ids = list.map((item) => item?.id);
    if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Each configured check and criterion needs a unique non-empty id.');
  }
  for (const check of settings.checks || []) if (typeof check.executable !== 'string' || !Array.isArray(check.args) || check.args.some((arg) => typeof arg !== 'string') || (check.outputDirs !== undefined && (!Array.isArray(check.outputDirs) || check.outputDirs.some((dir) => typeof dir !== 'string')))) throw new Error('Invalid structured executable, argument array or output directories.');
  for (const criterion of settings.criteria || []) if (typeof criterion.text !== 'string' || !criterion.text.trim() || (criterion.check !== undefined && typeof criterion.check !== 'string') || (criterion.manual !== undefined && typeof criterion.manual !== 'boolean')) throw new Error('Acceptance criteria need reviewable text and a check id or manual review.');
}

export function checkDefinitions(root, settings = {}) {
  validateVerificationSettings(settings);
  if (Array.isArray(settings.checks)) return settings.checks;
  const tests = testDefinitions(root, settings);
  let pkg = null; try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch {}
  const script = settings.buildCommand || pkg?.scripts?.build || pkg?.scripts?.typecheck;
  if (!script) return tests;
  const tokens = String(script).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((arg) => arg.replace(/^["']|["']$/g, '')) || [];
  const executable = tokens.shift();
  const common = { id: 'build', cwd: '.', scope: 'full', format: 'exit', outputDirs: [] };
  if (!/[;&|<>`$]/.test(script) && executable === 'node') return [...tests, { ...common, executable, args: tokens }];
  if (!/[;&|<>`$]/.test(script) && executable === 'tsc') return [...tests, { ...common, executable: 'node', args: ['node_modules/typescript/bin/tsc', ...tokens] }];
  return [...tests, { ...common, executable: executable || '', args: tokens, format: 'unsupported' }];
}

export function captureBaseline(store, task, checkpoint, settings = {}) {
  const file = baselineFile(store, task);
  const existing = readJson(file); if (existing) return existing;
  if (!checkpoint) return null;
  const shadow = new Shadow(store);
  const files = shadow.listFiles(checkpoint).filter(trustedFile);
  let checks = [], configurationReason = null;
  try { checks = checkDefinitions(store.root, settings); } catch (error) { configurationReason = error.message; }
  const baseline = { v: 2, task, checkpoint, files, checks, criteria: Array.isArray(settings.criteria) ? settings.criteria : [], configuredCriteriaHash:digest(settings.criteria || []), configurationReason, createdAt: new Date().toISOString() };
  try { baseline.dependencies = dependencyIdentity(store.root, undefined, baseline.checks, Date.now() + 10000); }
  catch (error) { baseline.dependencies = null; baseline.dependencyReason = error.message; }
  baseline.hash = digest(baseline);
  atomicJson(file, baseline);
  return baseline;
}

export function baselineProposal(store, task, checkpoint, settings = {}) {
  const baseline = readJson(baselineFile(store, task));
  if (!baseline) throw new Error('No task baseline. Start a task or run keel verify first.');
  const shadow = new Shadow(store);
  const changes = shadow.diffNames(baseline.checkpoint, checkpoint).filter((c) => trustedFile(c.path) || (c.oldPath && trustedFile(c.oldPath)));
  const checks = checkDefinitions(store.root, settings), criteria = confirmedCriteria(store,task,settings,baseline);
  const diff = shadow.git(['diff', '--no-ext-diff', baseline.checkpoint, checkpoint, '--', ...new Set([...baseline.files, ...changes.map((c) => c.path)])]);
  return { baseline, checkpoint, changes, checks, criteria, diff, configuredCriteriaHash:digest(settings.criteria || []), approval: digest({ baseline: baseline.hash, tree: shadow.git(['rev-parse', checkpoint + '^{tree}']).trim(), changes, checks, criteria }) };
}
export function approveBaseline(store, proposal, approval) {
  if (approval !== proposal.approval) throw new Error('Review the displayed diff and approve its exact hash.');
  const shadow = new Shadow(store);
  const next = { ...proposal.baseline, checkpoint: proposal.checkpoint, files: shadow.listFiles(proposal.checkpoint).filter(trustedFile), checks: proposal.checks, criteria: proposal.criteria, approvedAt: new Date().toISOString() };
  if(proposal.configuredCriteriaHash!==next.configuredCriteriaHash) {next.criteriaSource='configured';delete next.criteriaApproval;}
  next.configuredCriteriaHash=proposal.configuredCriteriaHash;
  next.dependencies = dependencyIdentity(store.root, undefined, next.checks);
  delete next.hash; delete next.inventory; delete next.dependencyReason; delete next.configurationReason; next.hash = digest(next);
  atomicJson(baselineFile(store, next.task), next);
  return next;
}

export function acceptanceProposal(store, task, criterionId, checkpoint, settings = {}) {
  const baseline = readJson(baselineFile(store, task));
  if (!baseline || digest(confirmedCriteria(store,task,settings,baseline)) !== digest(baseline.criteria)) throw new Error('Confirm the task criteria through baseline approval first.');
  const criterion = baseline.criteria.find((item) => item.id === criterionId);
  if (!criterion || (criterion.check && !criterion.manual)) throw new Error('No explicitly required manual criterion with that id.');
  const shadow = new Shadow(store);
  const identity = { task, criterion: criterionId, criterionHash: digest(criterion), baseline: baseline.hash, tree: shadow.git(['rev-parse', checkpoint + '^{tree}']).trim(), dependencies: dependencyIdentity(store.root, undefined, baseline.checks), runnerConfiguration: digest(baseline.checks), criteria: digest(baseline.criteria) };
  return { v: 2, identity, criterion, diff: shadow.git(['diff', '--no-ext-diff', '--no-textconv', baseline.checkpoint, checkpoint]), approval: digest(identity) };
}
export function approveAcceptance(store, proposal, approval) {
  if (approval !== proposal.approval) throw new Error('Manual acceptance requires the exact displayed snapshot and criterion hash.');
  atomicJson(acceptanceFile(store, proposal.identity.task, proposal.identity.criterion), { v: 2, identity: proposal.identity, decision: 'approved', approvedAt: new Date().toISOString(), scope: 'explicit manual review; ordinary host interface' });
}

function cleanEnvironment(temporary) {
  const env = { CI: '1', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local', GOENV: 'off', HOME: temporary, USERPROFILE: temporary, TEMP: temporary, TMP: temporary, TMPDIR: temporary };
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[name]) env[name] = process.env[name];
  return env;
}
function resolveRunner(executable, cwd) {
  if (path.isAbsolute(executable)) return executable;
  if (/[\\/]/.test(executable)) return path.resolve(cwd, executable);
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : [''];
  for (const directory of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    for (const extension of extensions) {
      const file = path.join(directory.replace(/^"|"$/g, ''), executable + extension);
      try { if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch {}
    }
  }
  throw new Error('Runner executable unavailable; shell launchers are not independent checks.');
}
export function currentRunnerIdentity(executable, root, format = '') {
  const binary = digest(fs.readFileSync(resolveRunner(executable === 'node' ? (process.versions.bun ? 'node' : process.execPath) : executable, root)));
  return format === 'node-events' ? digest({ binary, reporter: digest(NODE_REPORTER) }) : binary;
}
export function evidenceIntegrity(store, evidence) {
  const reasons = [];
  if (!/^[a-f0-9-]{36}$/i.test(evidence?.runId || '')) return ['Managed verification run identity is missing.'];
  const runDir = path.join(store.dir, 'verification', evidence.runId);
  const persisted = readJson(path.join(runDir, 'evidence.json'));
  if (!persisted || digest(persisted) !== digest(evidence)) reasons.push('Managed evidence record is missing or was changed.');
  for (const check of [...(evidence.checks || []), ...(evidence.proposedChecks || [])]) {
    if (!check.report) { if (check.verdict === 'verified') reasons.push(check.id + ': managed report unavailable.'); continue; }
    try {
      if (!within(fs.realpathSync(runDir), fs.realpathSync(check.report.path))) throw new Error('Outside managed run.');
      if (digest(fs.readFileSync(check.report.path)) !== check.report.hash) throw new Error('Report changed.');
      if (currentRunnerIdentity(check.command, store.root, check.report.format) !== check.runnerIdentity) throw new Error('Runner changed.');
    } catch { reasons.push(check.id + ': report or runner identity is unavailable or stale.'); }
  }
  for (const criterion of evidence.acceptance || []) if (criterion.manualEvidence) {
    const approval = readJson(acceptanceFile(store, evidence.task, criterion.id));
    if (approval?.decision !== 'approved' || digest(approval?.identity || {}) !== criterion.manualEvidence.identity) reasons.push(criterion.id + ': manual acceptance evidence is unavailable or stale.');
  }
  return reasons;
}
export function dependencyIdentity(root, copy, checks = checkDefinitions(root), deadline = Date.now() + 30000) {
  // A private dependency copy prevents checks from writing through a symlink to
  // the user's installation. Content, rather than mtimes, identifies it.
  const directory = path.join(root, 'node_modules');
  const hashes = {};
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (Date.now() > deadline) throw new Error('Dependency content capture timed out.');
      const name = prefix + entry.name, source = path.join(dir, entry.name), destination = copy ? path.join(copy, 'node_modules', name) : null;
      if (isSensitivePath(name)) continue;
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(source);
        if (!within(fs.realpathSync(directory), resolved)) throw new Error('External linked dependencies require a configured verifier environment.');
        const relative = path.relative(directory, resolved);
        hashes[name] = digest('link:' + relative.split(path.sep).join('/'));
        if (copy) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.symlinkSync(path.relative(path.dirname(destination), path.join(copy, 'node_modules', relative)), destination, fs.statSync(resolved).isDirectory() ? 'dir' : 'file'); }
        continue;
      }
      if (entry.isDirectory()) walk(source, name + '/');
      else if (entry.isFile()) { const bytes = fs.readFileSync(source); hashes[name] = digest(bytes); if (copy) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes); } }
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  const environments = [];
  for (const check of checks.filter((check) => check.format === 'pytest')) {
    if (Date.now() > deadline) throw new Error('Dependency content capture timed out.');
    const python = resolveRunner(check.executable, root);
    // Run only trusted interpreter metadata code, never a project helper. Hash
    // installed distribution files so an unchanged requirements file is not
    // mistaken for unchanged installed dependencies.
    const program = `import importlib.metadata as m,hashlib,json,pathlib,sys
items=[]
for distribution in m.distributions():
 for file in distribution.files or []:
  p=pathlib.Path(distribution.locate_file(file)).resolve()
  if p.suffix in ('.pyc','.pyo') or not p.is_file(): continue
  if not p.is_relative_to(pathlib.Path(sys.prefix).resolve()): raise RuntimeError('External Python distribution requires a configured verifier environment')
  items.append((str(p),hashlib.sha256(p.read_bytes()).hexdigest()))
print(hashlib.sha256(json.dumps(sorted(items)).encode()).hexdigest())`;
    const result = spawnSync(python, ['-I', '-c', program], { cwd: os.tmpdir(), env: cleanEnvironment(os.tmpdir()), encoding: 'utf8', timeout: Math.max(1, deadline - Date.now()), maxBuffer: 1024 * 1024, windowsHide: true });
    if (result.status !== 0 || !/^[a-f0-9]{64}\s*$/.test(result.stdout)) throw new Error('Installed Python dependency content identity unavailable.');
    environments.push(result.stdout.trim());
  }
  return digest({ node: Object.entries(hashes).sort(), environments });
}

export function verify(store, options = {}) {
  const { session = 'verification', task = session, settings = {}, checkpoint = null, baseline: supplied = null } = options;
  const shadow = new Shadow(store).init();
  const candidate = checkpoint || shadow.snapshot(session, `verify-${crypto.randomUUID()}`);
  const deadline = Date.now() + (settings.checkTimeoutSec ?? 120) * 1000;
  const remaining = () => { const seconds = (deadline - Date.now()) / 1000; if (seconds <= 0) throw new Error('Verification cycle timed out.'); return seconds; };
  const runId = crypto.randomUUID();
  const record = { v: 2, runId, task, session, verdict: 'not_verified', reasons: [], checks: [], checkpoint: candidate, protection: { mode: 'plugin', enforcement: 'best_effort', unavailable: ['process isolation', 'independent hook observer', 'external-resource recovery'] }, createdAt: new Date().toISOString() };
  const runDir = path.join(store.dir, 'verification', runId);
  fs.mkdirSync(runDir, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-verify-'));
  const copy = path.join(temporary, 'workspace'); fs.mkdirSync(copy);
  try {
    if (settings.configurationError) throw new Error(settings.configurationError);
    validateVerificationSettings(settings);
    if (!candidate) throw new Error('Snapshot unavailable.');
    const baseline = supplied || readJson(baselineFile(store, task)) || captureBaseline(store, task, candidate, settings);
    if (!baseline) throw new Error('Trusted baseline unavailable.');
    if (baseline.configurationReason) record.reasons.push(baseline.configurationReason);
    if (baseline.dependencyReason) record.reasons.push('Baseline dependency identity unavailable: ' + baseline.dependencyReason);
    const definitions = baseline.checks;
    if (!definitions?.length) throw new Error('No supported structured full-suite checks configured. Legacy shell commands are diagnostic only.');
    if (digest(checkDefinitions(store.root, settings)) !== digest(definitions)) record.reasons.push('Verification configuration changed; baseline approval required.');
    if (digest(confirmedCriteria(store,task,settings,baseline)) !== digest(baseline.criteria)) record.reasons.push('Acceptance criteria changed; baseline approval required.');
    const changes = shadow.diffNames(baseline.checkpoint, candidate);
    if (changes.some((c) => baseline.files.includes(c.path) || baseline.files.includes(c.oldPath))) record.reasons.push('Trusted tests, fixtures, configuration or dependencies changed; baseline approval required.');
    const tampering = findTestTampering(changes, (file, side) => shadow.show(side === 'before' ? baseline.checkpoint : candidate, file));
    if (tampering.length) { record.reasons.push('Test removals or unauthorized skip/focus controls detected.'); record.verdict = 'failed'; }
    exportSnapshot(shadow, candidate, copy);
    const candidateManifest = manifest(copy);
    const dependencyHash = dependencyIdentity(store.root, copy, definitions, deadline);
    if (baseline.dependencies !== dependencyHash) record.reasons.push('Dependency content changed; baseline approval required.');
    if (!baseline.inventory) {
      const original = path.join(temporary, 'baseline'); fs.mkdirSync(original);
      exportSnapshot(shadow, baseline.checkpoint, original);
      dependencyIdentity(store.root, original, definitions, deadline);
      const baselineReports = path.join(runDir, 'baseline'); fs.mkdirSync(baselineReports);
      const initial = definitions.map((definition) => runDefinition(definition, original, temporary, baselineReports, remaining()));
      baseline.inventory = initial.map((check) => ({ id: check.id, inventory: check.inventory || null, counts: check.counts || null, runnerIdentity: check.runnerIdentity, verdict: check.verdict, reason: check.reason }));
      // A failed baseline is retained as known history, never silently called passing.
      atomicJson(baselineFile(store, task), baseline);
    }
    const proposedFiles = changes.filter((c) => c.status === 'A' && isTestFile(c.path)).map((c) => c.path);
    for (const file of proposedFiles) fs.rmSync(path.join(copy, relativeFile(copy, file)), { force: true });
    for (const file of baseline.files) {
      relativeFile(copy, file);
      const text = blob(shadow, baseline.checkpoint, file);
      if (text == null) throw new Error('Trusted baseline content unavailable.');
      fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
      fs.writeFileSync(path.join(copy, file), text);
    }
    record.identity = { source: digest(candidateManifest), baseline: baseline.hash, runnerConfiguration: digest(definitions), dependencies: dependencyHash, criteria: digest(baseline.criteria), scope: digest(definitions.map((c) => [c.id, c.scope])) };
    const outputDirs = [...new Set(definitions.flatMap((definition) => definition.outputDirs || []))].map((directory) => relativeFile(copy, directory));
    if (outputDirs.some((directory) => !directory || [...baseline.files, ...Object.keys(candidateManifest)].some((file) => file === directory || file.startsWith(directory + '/')))) throw new Error('Declared output overlaps captured source or trusted verification inputs.');
    const before = checkManifest(copy, outputDirs);
    for (const definition of definitions) {
      const check = runDefinition(definition, copy, temporary, runDir, remaining());
      record.checks.push(check);
      const expected = baseline.inventory?.find((item) => item.id === check.id);
      if (expected?.runnerIdentity && expected.runnerIdentity !== check.runnerIdentity) record.reasons.push(definition.id + ': runner binary changed.');
      if (definition.format !== 'exit' && !expected?.inventory) record.reasons.push(definition.id + ': baseline inventory unavailable.');
      else if (check.inventory) {
        const actual = new Map(check.inventory.map((item) => [item.id, item.status]));
        if (expected.inventory.some((item) => !actual.has(item.id) || (actual.get(item.id) === 'skipped' && item.status !== 'skipped'))) { check.verdict = 'failed'; check.reason = 'Baseline test disappeared or became skipped.'; }
      }
      if (check.verdict === 'failed') record.verdict = 'failed';
      if (check.verdict !== 'verified') record.reasons.push(`${definition.id}: ${check.reason || check.verdict}`);
    }
    if (proposedFiles.length || changes.some((c) => baseline.files.includes(c.path) && isTestFile(c.path))) {
      const proposed = path.join(temporary, 'proposed'); fs.mkdirSync(proposed);
      exportSnapshot(shadow, candidate, proposed); dependencyIdentity(store.root, proposed, definitions, deadline);
      const proposedBefore = checkManifest(proposed, outputDirs);
      const proposedReports = path.join(runDir, 'proposed'); fs.mkdirSync(proposedReports);
      record.proposedChecks = definitions.map((definition) => runDefinition(definition, proposed, temporary, proposedReports, remaining()));
      for (const check of record.proposedChecks) if (check.verdict !== 'verified') { record.reasons.push('Proposed tests: ' + check.reason); if (check.verdict === 'failed') record.verdict = 'failed'; }
      if (digest(proposedBefore) !== digest(checkManifest(proposed, outputDirs)) || dependencyIdentity(proposed, undefined, definitions, deadline) !== dependencyHash) record.reasons.push('Proposed tests changed source or dependencies.');
    }
    if (dependencyIdentity(store.root, undefined, definitions, deadline) !== dependencyHash || dependencyIdentity(copy, undefined, definitions, deadline) !== dependencyHash) record.reasons.push('Dependencies changed during verification.');
    if (digest(before) !== digest(checkManifest(copy, outputDirs))) record.reasons.push('Tests changed source or trusted verification files.');
    const current = shadow.snapshot(session, `verified-current-${runId}`, candidate);
    if (!current || shadow.git(['rev-parse', `${candidate}^{tree}`]).trim() !== shadow.git(['rev-parse', `${current}^{tree}`]).trim()) record.reasons.push('Workspace changed during verification.');
    if (readJson(baselineFile(store, task))?.hash !== baseline.hash) record.reasons.push('Trusted baseline changed during verification.');
    record.acceptance = [];
    for (const criterion of baseline.criteria) {
      let accepted = !!criterion.check && record.checks.some((check) => check.id === criterion.check && check.verdict === 'verified');
      let manualEvidence = null;
      if (!criterion.check || criterion.manual) {
        const approval = readJson(acceptanceFile(store, task, criterion.id));
        const expected = { task, criterion: criterion.id, criterionHash: digest(criterion), baseline: baseline.hash, tree: shadow.git(['rev-parse', candidate + '^{tree}']).trim(), dependencies: dependencyHash, runnerConfiguration: digest(definitions), criteria: digest(baseline.criteria) };
        const manualAccepted = approval?.v === 2 && approval.decision === 'approved' && digest(approval.identity) === digest(expected);
        accepted = criterion.check ? accepted && manualAccepted : manualAccepted;
        if (manualAccepted) manualEvidence = { approvedAt: approval.approvedAt, identity: digest(approval.identity) };
      }
      record.acceptance.push({ id: criterion.id, accepted, check: criterion.check || null, manualEvidence });
      if (!accepted) record.reasons.push(`Criterion lacks current check or manual acceptance evidence: ${criterion.id || criterion.text || 'unnamed'}`);
    }
    if (record.verdict !== 'failed' && record.reasons.length === 0 && record.checks.length === definitions.length) record.verdict = 'verified';
    if (record.verdict === 'verified' && options.markGreen !== false) shadow.markGreen(session, candidate);
  } catch (error) { record.reasons.push(error instanceof Error ? error.message : String(error)); }
  finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  atomicJson(path.join(runDir, 'evidence.json'), record);
  store.append(makeEvent('verification', { agent: 'keel', session, turn: options.turn || null }, { evidence: record }));
  return record;
}

function runDefinition(definition, copy, temporary, runDir, timeout) {
  const result = { id: definition.id, scope: definition.scope, command: definition.executable, args: definition.args, cwd: definition.cwd, runnerVersion: null, exitCode: null, verdict: 'not_verified', reason: '', report: null, durationMs: 0 };
  const start = Date.now();
  try {
    if (!definition.id || definition.scope !== 'full' || !Array.isArray(definition.args) || !['node-events', 'node-tap', 'jest', 'vitest', 'pytest', 'go', 'junit', 'exit'].includes(definition.format)) throw new Error('Check needs an id, pinned full scope, argument array and supported report format.');
    if (!definition.executable || typeof definition.executable !== 'string') throw new Error('Invalid check executable.');
    const cwdRel = definition.cwd === '.' || !definition.cwd ? '' : relativeFile(copy, definition.cwd);
    const cwd = path.join(copy, cwdRel);
    if (definition.format === 'node-events' && (!/^node(?:\.exe)?$/i.test(path.basename(definition.executable)) || !definition.args.includes('--test'))) throw new Error('Native Node evidence requires node --test and the managed reporter.');
    for (const arg of definition.args) {
      const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
      // Reports are the only explicit host-side path given to a check. Source,
      // test and configuration paths must resolve in the captured workspace.
      if (value === '{report}') continue;
      if (value.includes('{report}') || path.isAbsolute(value) || /^file:/i.test(value) || (/(^|[\\/])\.\.(?:[\\/]|$)/.test(value) && !within(copy, path.resolve(cwd,value)))) throw new Error('Check arguments reference uncaptured host paths; use project-relative inputs.');
    }
    const executable = resolveRunner(definition.executable === 'node' ? (process.versions.bun ? 'node' : process.execPath) : definition.executable, cwd);
    result.runnerIdentity = currentRunnerIdentity(executable, cwd, definition.format);
    const reportPath = path.join(runDir, `${keyFor(definition.id)}.report`);
    const substitutions = (arg) => String(arg).replaceAll('{report}', reportPath);
    let args = definition.args.map(substitutions);
    if (definition.format === 'node-events') {
      const reporter = path.join(temporary, 'keel-native-node-reporter.mjs');
      fs.writeFileSync(reporter, NODE_REPORTER, { mode: 0o600 });
      args = args.filter((arg, index) => !arg.startsWith('--test-reporter=') && arg !== '--test-reporter' && args[index - 1] !== '--test-reporter');
      args.unshift('--test-reporter=' + pathToFileURL(reporter).href);
    }
    const version = spawnSync(executable, definition.executable === 'go' ? ['version'] : ['--version'], { encoding: 'utf8', env: cleanEnvironment(temporary), timeout: 5000, windowsHide: true });
    result.runnerVersion = version.status === 0 ? version.stdout.trim().slice(0, 200) : null;
    if (!result.runnerVersion) throw new Error('Runner version unavailable.');
    // Prevent reuse of a report from an earlier check or agent-controlled tree.
    fs.rmSync(reportPath, { force: true });
    const child = spawnSync(executable, args, { cwd, encoding: 'utf8', env: cleanEnvironment(temporary), timeout: timeout * 1000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    result.exitCode = child.status;
    if (child.error || child.signal || child.status == null) throw new Error((/** @type {any} */ (child.error))?.code === 'ETIMEDOUT' ? 'Verification timed out.' : 'Runner outcome unavailable.');
    if (child.status !== 0) { result.verdict = 'failed'; result.reason = `Runner exited ${child.status}.`; }
    const fromFile = definition.args.some((arg) => String(arg).includes('{report}'));
    if (fromFile && (!fs.lstatSync(reportPath).isFile() || fs.lstatSync(reportPath).isSymbolicLink() || !within(fs.realpathSync(runDir), fs.realpathSync(reportPath)))) throw new Error('Report must be a fresh regular file inside the managed run.');
    const report = fromFile ? fs.readFileSync(reportPath, 'utf8') : child.stdout;
    if (!fromFile) fs.writeFileSync(reportPath, report, { mode: 0o600 });
    if (definition.format === 'exit') {
      result.report = { path: reportPath, hash: digest(report), format: 'exit' };
      if (child.status === 0) result.verdict = 'verified';
      result.durationMs = Date.now() - start;
      return result;
    }
    const parsed = parseReport(definition.format, report);
    result.report = { path: reportPath, hash: digest(report), format: definition.format };
    // Normalize private temporary paths so inventory identities survive captures.
    result.inventory = parsed.tests.map((t) => ({ ...t, id: t.id.replaceAll(copy, '<workspace>').replaceAll(copy.replace(/\\/g, '/'), '<workspace>') }));
    result.counts = { discovered: parsed.discovered, executed: parsed.executed, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped };
    if (parsed.failed || parsed.suiteFailed) { result.verdict = 'failed'; result.reason = parsed.failed ? 'One or more tests failed.' : 'The runner reported a failed suite.'; }
    else if (child.status === 0) result.verdict = 'verified';
  } catch (error) { result.reason = error instanceof Error ? error.message : String(error); if (result.reason.includes('zero tests')) result.verdict = 'failed'; }
  result.durationMs = Date.now() - start;
  return result;
}
