// Session integration and inverse patches. Never uses the project's Git index,
// commits, stashes or reset. Conflicts are discovered before any write.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Shadow } from './checkpoint.mjs';
import { relativeFile, excludedPath } from './policy.mjs';
import { blob, atomicJson, readJson, keyFor } from './workspace.mjs';
import { makeEvent } from './events.mjs';

const same = (a, b) => a === b;
const encode = (bytes) => bytes == null ? null : bytes.toString('base64');
const decode = (text) => text == null ? null : Buffer.from(text, 'base64');
function current(root, file) {
  relativeFile(root, file);
  const target = path.join(root, file);
  try { const stat = fs.lstatSync(target); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Special file or link needs manual review.'); return { content: encode(fs.readFileSync(target)), mode: stat.mode & 0o777 }; }
  catch (error) { if (error.code === 'ENOENT') return { content: null, mode: null }; throw error; }
}
function merge(base, incoming, actual) {
  if (same(actual, base)) return incoming;
  if (same(actual, incoming) || same(base, incoming)) return actual;
  if ([base, incoming, actual].some((s) => s == null || decode(s).includes(0))) throw new Error('Overlapping deletion, addition or binary change.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-merge-'));
  try {
    for (const [name, value] of Object.entries({ current: actual, base, incoming })) fs.writeFileSync(path.join(dir, name), decode(value));
    const result = spawnSync('git', ['merge-file', '-p', path.join(dir, 'current'), path.join(dir, 'base'), path.join(dir, 'incoming')], { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (result.status !== 0 || result.error) throw new Error('Overlapping edits require manual resolution.');
    return encode(result.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
export function checkpointPatch(store, before, after) {
  const shadow = new Shadow(store).init();
  const metadata = shadow.git(['diff', '--raw', '--no-renames', '-z', before, after]);
  for (const match of metadata.matchAll(/:(\d{6}) (\d{6}) [a-f0-9]+ [a-f0-9]+ [A-Z]/g)) {
    if (match[1] !== '000000' && match[2] !== '000000' && match[1] !== match[2]) throw new Error('Permission or file-type changes require manual review.');
    if ([match[1], match[2]].includes('120000')) throw new Error('Symlink changes require manual review.');
    if ([match[1], match[2]].includes('000000') && [match[1], match[2]].includes('100755')) throw new Error('Adding or deleting executable files requires manual review.');
  }
  const files = new Set([...shadow.listFiles(before), ...shadow.listFiles(after)]);
  const previous = new Set(shadow.listFiles(before)), next = new Set(shadow.listFiles(after));
  const entries = [];
  for (const file of files) {
    if (excludedPath(file)) throw new Error('Legacy checkpoint contains excluded files; audit the store.');
    const base = previous.has(file) ? encode(blob(shadow, before, file)) : null;
    const incoming = next.has(file) ? encode(blob(shadow, after, file)) : null;
    if (base !== incoming) entries.push({ path: file, base, incoming });
  }
  return entries;
}

export function transact(store, session, entries, options = {}) {
  const id = crypto.randomUUID(), directory = path.join(store.dir, 'transactions');
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, 'write.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('Another integration or undo is active. A stale lock requires recovery review.'); }
  try {
    const conflicts = [], prepared = [];
    const canonical = entries.map((e) => relativeFile(store.root, e.path));
    if (new Set(canonical.map((file) => process.platform === 'win32' ? file.toLowerCase() : file)).size !== entries.length) throw new Error('Duplicate transaction path.');
    for (const entry of entries) {
      try {
        if (excludedPath(entry.path)) throw new Error('Excluded path.');
        const state = current(store.root, entry.path);
        const after = merge(entry.base, entry.incoming, state.content);
        if (after !== state.content) prepared.push({ path: entry.path, before: state.content, after, mode: state.mode });
      } catch (error) { conflicts.push({ path: entry.path, reason: error.message }); }
    }
    const transaction = { v: 2, id, session, kind: options.kind || 'apply', inverseOf: options.inverseOf || null, createdAt: new Date().toISOString(), state: conflicts.length ? 'conflict' : options.dryRun ? 'preview' : 'prepared', entries: prepared, conflicts };
    if (conflicts.length || options.dryRun) {
      if (conflicts.length && !options.dryRun) {
        atomicJson(path.join(directory, `${id}.json`), transaction);
        store.append(makeEvent('transaction', { agent: 'keel', session }, { transaction: id, operation: transaction.kind, outcome: 'conflict', conflicts: conflicts.map((conflict) => conflict.path) }));
      }
      return transaction;
    }
    const file = path.join(directory, `${id}.json`);
    atomicJson(file, transaction);
    const written = [];
    try {
      for (const entry of prepared) {
        const now = current(store.root, entry.path);
        if (now.content !== entry.before || now.mode !== entry.mode) throw new Error('Workspace changed after preview.');
        write(store.root, entry.path, entry.after, entry.mode);
        written.push(entry);
      }
      transaction.state = 'applied';
      atomicJson(file, transaction);
      atomicJson(path.join(directory, 'latest.json'), { id });
      store.append(makeEvent('transaction', { agent: 'keel', session }, { transaction: id, operation: transaction.kind, files: prepared.map((e) => e.path) }));
      return transaction;
    } catch (error) {
      const rollbackConflicts = [];
      for (const entry of written.reverse()) {
        try { if (current(store.root, entry.path).content !== entry.after) throw new Error('Concurrent edit.'); write(store.root, entry.path, entry.before, entry.mode); }
        catch { rollbackConflicts.push(entry.path); }
      }
      transaction.state = 'failed'; transaction.rollbackConflicts = rollbackConflicts;
      atomicJson(file, transaction);
      throw new Error(`Integration failed; transaction ${id} records recovery${rollbackConflicts.length ? ' conflicts' : ''}: ${error.message}`);
    }
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }); }
}
function write(root, file, content, mode) {
  relativeFile(root, file);
  const target = path.join(root, file);
  if (content == null) { fs.unlinkSync(target); return; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.keel-${crypto.randomUUID()}`;
  try { fs.writeFileSync(temporary, decode(content), { mode: mode || 0o644, flag: 'wx' }); fs.renameSync(temporary, target); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function undoTransaction(store, options = {}) {
  const directory = path.join(store.dir, 'transactions');
  const latest = readJson(path.join(directory, 'latest.json'));
  const transaction = latest && readJson(path.join(directory, `${latest.id}.json`));
  if (!transaction || transaction.state !== 'applied') throw new Error('No successful transaction to undo.');
  if (options.direction === 'redo' && transaction.kind !== 'undo') throw new Error('No successful undo transaction to redo.');
  return transact(store, transaction.session, transaction.entries.map((e) => ({ path: e.path, base: e.after, incoming: e.before })), { ...options, kind: transaction.kind === 'undo' ? 'redo' : 'undo', inverseOf: transaction.id });
}
export function sessionRevert(store, session, options = {}) {
  const events = store.readSession(session);
  const observations = events.filter((e) => e.kind === 'tool_result' && e.beforeCheckpoint && e.afterCheckpoint);
  const shadow = new Shadow(store).init();
  const first = events.find((e) => e.kind === 'turn_start' && e.checkpoint);
  const last = [...events].reverse().find((e) => e.kind === 'turn_end' && e.checkpoint);
  const refuse = (message) => {
    let recovery = '';
    if (first?.checkpoint && last?.checkpoint) {
      // This patch deliberately carries no ownership claim and is never applied
      // automatically. Review it for pre-existing/manual work before use.
      const files = [...new Set([...shadow.listFiles(first.checkpoint), ...shadow.listFiles(last.checkpoint)])];
      if (!files.some(excludedPath)) {
        const directory = path.join(store.dir, 'recovery'); fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, `${keyFor(session)}-${crypto.randomUUID()}.patch`);
        const patch = shadow.git(['diff', '--binary', '--no-ext-diff', '--no-textconv', last.checkpoint, first.checkpoint]);
        fs.writeFileSync(file, patch, { flag: 'wx', mode: 0o600 });
        recovery = ` Review-only recovery patch (may include unowned work): ${file}`;
      }
    }
    throw new Error(message + ' No files changed.' + recovery);
  };
  if (!first || !last || !observations.length) return refuse('Session ownership is ambiguous. No automatic restore.');
  if (events.some((event) => event.ownershipReason)) return refuse('Tool or subagent ownership is incomplete; selective undo requires manual review.');
  if (events.slice(events.indexOf(last) + 1).some((event) => event.kind === 'turn_start' || event.kind === 'tool_call' || event.kind === 'tool_result')) return refuse('The session has observable activity after its last completed checkpoint.');
  const aggregate = checkpointPatch(store, first.checkpoint, last.checkpoint);
  const observed = new Map();
  for (const observation of observations) for (const entry of checkpointPatch(store, observation.beforeCheckpoint, observation.afterCheckpoint)) {
    const previous = observed.get(entry.path);
    if (previous && previous.incoming !== entry.base) return refuse('Unobserved or overlapping changes; selective undo requires manual review.');
    observed.set(entry.path, { ...entry, base: previous?.base ?? entry.base });
  }
  if (aggregate.some((e) => !observed.has(e.path) || observed.get(e.path).base !== e.base || observed.get(e.path).incoming !== e.incoming)) return refuse('Unobserved or concurrent changes; selective undo requires manual review.');
  // Other sessions with activity during this session make attribution ambiguous.
  for (const other of store.listSessions().filter((s) => s !== session)) if (store.readSession(other).some((e) => e.kind === 'tool_result' && e.t >= first.t && e.t <= last.t && (e.files?.length || e.command))) return refuse('Overlapping session activity requires manual review.');
  return transact(store, session, aggregate.map((e) => ({ path: e.path, base: e.incoming, incoming: e.base })), { ...options, kind: 'revert' });
}
export function transactionText(result) {
  return `${result.state}: ${result.id}\n${result.entries.map((e) => e.path).join('\n')}\n${result.conflicts.map((c) => `${c.path}: ${c.reason}`).join('\n')}${result.conflicts.length ? '\nNo files changed.' : ''}\n`;
}
