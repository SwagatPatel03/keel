import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { excludedPath, isSensitivePath, relativeFile } from './policy.mjs';

export const digest = (value) => crypto.createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const keyFor = (id) => digest(String(id)).slice(0, 32);
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
export function blob(shadow, commit, file) {
  if (excludedPath(file)) throw new Error('Excluded checkpoint path.');
  relativeFile(shadow.work, file);
  return execFileSync('git', [`--git-dir=${shadow.gitDir}`, 'show', `${commit}:${file}`], { maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
export function exportSnapshot(shadow, commit, destination) {
  const entries = shadow.git(['ls-tree', '-r', '-z', commit]).split('\0').filter(Boolean);
  for (const entry of entries) {
    const match = /^(100644|100755) blob [a-f0-9]+\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Checkpoint contains a link or special file requiring review.');
    const file = match[2];
    if (excludedPath(file)) throw new Error('Checkpoint contains excluded paths; audit legacy storage before using it.');
    relativeFile(destination, file);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, blob(shadow, commit, file), { mode: match[1] === '100755' ? 0o755 : 0o644 });
  }
}
export function manifest(root, outputDirs = []) {
  const result = {};
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = prefix + entry.name;
      if (excludedPath(file) || outputDirs.some((d) => file === d || file.startsWith(d + '/'))) continue;
      relativeFile(root, file);
      if (entry.isSymbolicLink()) throw new Error('Workspace links need manual review.');
      if (entry.isDirectory()) walk(path.join(dir, entry.name), file + '/');
      else if (entry.isFile()) result[file] = digest(fs.readFileSync(path.join(dir, entry.name)));
    }
  }
  walk(root);
  return result;
}

// Inside a disposable verifier, ignore only explicitly declared outputs and
// separately hashed dependencies. Newly generated ignored files still count.
export function checkManifest(root, outputDirs = []) {
  const result = {};
  const walk = (dir, prefix = '', output = false) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = prefix + entry.name;
      if (file === 'node_modules' || file.startsWith('node_modules/')) continue;
      const allowedOutput = output || outputDirs.some((d) => file === d || file.startsWith(d + '/'));
      relativeFile(root, file);
      if (entry.isSymbolicLink()) throw new Error('Check created a filesystem link.');
      if (isSensitivePath(file)) throw new Error('Check created a sensitive path; its contents were not recorded.');
      if (entry.isDirectory()) { if (!allowedOutput) result[file + '/'] = 'directory'; walk(path.join(dir, entry.name), file + '/', allowedOutput); }
      else if (entry.isFile()) { if (!allowedOutput) result[file] = digest(fs.readFileSync(path.join(dir, entry.name))); }
      else throw new Error('Check created a special file.');
    }
  };
  walk(root); return result;
}

// Legacy stores are audited by object path only. Never print or load secret blobs.
export function auditStore(shadow) {
  if (!fs.existsSync(path.join(shadow.gitDir, 'HEAD'))) return { quarantined: false, paths: [] };
  const paths = [...new Set(shadow.git(['rev-list', '--objects', '--all']).split('\n').map((line) => line.slice(line.indexOf(' ') + 1)).filter((file) => excludedPath(file)))];
  for (const index of fs.readdirSync(shadow.gitDir).filter((file) => /^index(?:-|$)/.test(file) && !file.endsWith('.lock'))) {
    const env = { GIT_INDEX_FILE: path.join(shadow.gitDir, index), GIT_LITERAL_PATHSPECS: '1' };
    const excluded = shadow.git(['ls-files', '-z'], { env }).split('\0').filter((file) => file && excludedPath(file));
    paths.push(...excluded);
    if (excluded.length) shadow.git(['update-index', '--force-remove', '-z', '--stdin'], { env, input: excluded.join('\0') + '\0' });
  }
  const result = { quarantined: paths.length > 0, paths, auditedAt: new Date().toISOString() };
  atomicJson(path.join(shadow.store.dir, 'checkpoint-audit.json'), result);
  return result;
}
