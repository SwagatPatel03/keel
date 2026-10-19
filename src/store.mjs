// Keel's local store. Everything lives under ~/.keel (or $KEEL_HOME):
//
//   ~/.keel/config.json                       user settings (optional)
//   ~/.keel/projects/<project-id>/project.json  which folder this is
//   ~/.keel/projects/<project-id>/sessions/<session>.jsonl  append-only events
//   ~/.keel/projects/<project-id>/receipts/<session>.txt    session receipts
//   ~/.keel/projects/<project-id>/shadow.git  checkpoints (see checkpoint.mjs)
//   ~/.keel/projects/<project-id>/errors.log  Keel's own failures
//
// Nothing is written inside the user's project, and nothing leaves the machine.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { NEW_TOKEN_BUDGETS } from './budget.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  // Run the project's declared test command when Claude makes an unproven claim.
  runChecks: true,
  checkTimeoutSec: 120,
  // Repeats of the same error, or returns of a file to the same content, that count as a loop.
  loopThreshold: 3,
  // Command guard and protected paths. mode: beginner (all packs), standard
  // (filesystem, git, secrets, databases) or off. allow: regular expressions for
  // commands to let through; protect: extra path globs to ask about;
  // allowPaths: path globs never to ask about.
  guard: { mode: 'beginner', allow: [], protect: [], allowPaths: [] },
  // Per-task budgets, in budget units (tokens weighed by price; see budget.mjs).
  // budgetUnits "new-tokens" counts input, output and cache writes instead; a
  // config that sets budgets without budgetUnits is read that way.
  budgets: { trivial: 40000, small: 90000, feature: 450000, risky: 450000 },
  budgetUnits: /** @type {'weighted'|'new-tokens'} */ ('weighted'),
  // At 100% of a task's budget: warn (the agent carries on) or stop it once.
  budget: { onLimit: /** @type {'warn'|'stop'} */ ('warn') },
  // Checkpoints: sessions older than keepDays are deleted, and the oldest
  // sessions while the store is larger than maxSizeMB. The latest green
  // checkpoint is always kept.
  checkpoints: { keepDays: 30, maxSizeMB: 1024 },
  // Learning notes on debugging turns and when something new is added: on or off.
  learn: { mode: 'on' },
  // Per-project overrides, keyed by absolute project path: { testCommand, buildCommand, runChecks, guard, budgets, learn }.
  projects: {},
});

export function keelHome() {
  return process.env.KEEL_HOME || path.join(os.homedir(), '.keel');
}

/** @type {Map<string, string>} */
const keys = new Map();

/**
 * A random key made once per install and kept in Keel's home folder, for the
 * keyed hashes of file names (sizer.mjs). Without it, anyone with the project
 * could hash its file list and match the stored values. If the key cannot be
 * saved, a fixed key is used, which is no weaker than a plain hash.
 */
export function installKey() {
  const home = keelHome();
  const known = keys.get(home);
  if (known) return known;
  const file = path.join(home, 'install.key');
  const read = () => { try { const k = fs.readFileSync(file, 'utf8').trim(); return k.length >= 32 ? k : null; } catch { return null; } };
  let key = read();
  if (!key) {
    try {
      fs.mkdirSync(home, { recursive: true });
      // wx: when two hooks start at once, the second keeps the first one's key.
      fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    } catch { /* written by another hook, or not writable */ }
    key = read() || 'keel-unsaved-key';
  }
  keys.set(home, key);
  return key;
}

/** @returns {typeof DEFAULT_CONFIG & {configurationError?: string}} */
export function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(keelHome(), 'config.json'), 'utf8'));
    const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(raw)) throw new Error('Configuration must be an object.');
    for (const field of ['guard','budgets','budget','checkpoints','learn','projects']) if (raw[field] !== undefined && !object(raw[field])) throw new Error('Invalid configuration section.');
    for (const override of Object.values(raw.projects || {})) if (!object(override)) throw new Error('Invalid project configuration.');
    // Budgets written before budget units existed are in new tokens.
    const legacy = raw.budgets && !raw.budgetUnits;
    const budgetUnits = raw.budgetUnits === 'new-tokens' || legacy ? 'new-tokens' : 'weighted';
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      guard: { ...DEFAULT_CONFIG.guard, ...(raw.guard || {}) },
      budgetUnits,
      budgets: { ...(budgetUnits === 'new-tokens' ? NEW_TOKEN_BUDGETS : DEFAULT_CONFIG.budgets), ...(raw.budgets || {}) },
      budget: { ...DEFAULT_CONFIG.budget, ...(raw.budget || {}) },
      checkpoints: { ...DEFAULT_CONFIG.checkpoints, ...(raw.checkpoints || {}) },
      learn: { ...DEFAULT_CONFIG.learn, ...(raw.learn || {}) },
      projects: { ...(raw.projects || {}) },
    };
  } catch (error) {
    return { ...DEFAULT_CONFIG, projects: {}, ...((/** @type {any} */ (error)).code === 'ENOENT' ? {} : { configurationError: 'Host configuration is invalid or unreadable; default settings are diagnostic only.' }) };
  }
}

/**
 * Per-project settings merged over the global ones.
 * @param {ReturnType<typeof loadConfig>} config
 * @param {string} root
 */
export function projectSettings(config, root) {
  const overrides = config.projects[root] || config.projects[root.replace(/\\/g, '/')] || {};
  return {
    ...config,
    ...overrides,
    guard: { ...config.guard, ...(overrides.guard || {}) },
    budgets: { ...config.budgets, ...(overrides.budgets || {}) },
    budget: { ...config.budget, ...(overrides.budget || {}) },
    learn: { ...config.learn, ...(overrides.learn || {}) },
  };
}

/**
 * The project folder for a session: the agent's project dir when given, else
 * the enclosing git work tree, else the working directory.
 * @param {string} cwd
 * @param {string|undefined} [projectDir]
 */
export function resolveRoot(cwd, projectDir) {
  if (projectDir) return path.resolve(projectDir);
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    if (top) return path.resolve(top);
  } catch { /* not a git work tree */ }
  return path.resolve(cwd);
}

/** A readable, stable id for a project folder: "<name>-<8 hex>". */
export function projectId(root) {
  const norm = path.resolve(root).replace(/\\/g, '/');
  const key = process.platform === 'win32' ? norm.toLowerCase() : norm;
  const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
  const name = path.basename(norm).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
  return `${name}-${hash}`;
}

export class ProjectStore {
  /** @param {string} root */
  constructor(root) {
    this.root = path.resolve(root);
    this.id = projectId(this.root);
    this.dir = path.join(keelHome(), 'projects', this.id);
    this.sessionsDir = path.join(this.dir, 'sessions');
    this.receiptsDir = path.join(this.dir, 'receipts');
    this.shadowDir = path.join(this.dir, 'shadow.git');
  }

  ensure() {
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.mkdirSync(this.receiptsDir, { recursive: true });
    const meta = path.join(this.dir, 'project.json');
    if (!fs.existsSync(meta)) {
      fs.writeFileSync(meta, JSON.stringify({ root: this.root, created: new Date().toISOString() }, null, 2));
    }
    return this;
  }

  /** @param {string} session */
  sessionFile(session) {
    return path.join(this.sessionsDir, `${safeName(session)}.jsonl`);
  }

  /** Appends one event as a single line, so parallel hooks do not interleave. */
  append(event) {
    this.ensure();
    fs.appendFileSync(this.sessionFile(event.session), JSON.stringify(event) + '\n');
  }

  /** @param {string} session @returns {any[]} */
  readSession(session) {
    let text;
    try { text = fs.readFileSync(this.sessionFile(session), 'utf8'); } catch { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const event = JSON.parse(line); if (!event || typeof event !== 'object' || ![1, 2].includes(event.v)) { out.push({ v: 2, kind: 'keel_error', session, reason: 'Unsupported or malformed event record.' }); } else out.push(event); } catch { out.push({ v: 2, kind: 'keel_error', session, reason: 'Torn event record; evidence is incomplete.' }); }
    }
    return mergeAmendments(out);
  }

  /** Session ids, most recently active first. */
  listSessions() {
    let names = [];
    try { names = fs.readdirSync(this.sessionsDir).filter((n) => n.endsWith('.jsonl')); } catch { return []; }
    return names
      .map((n) => ({ id: n.slice(0, -6), mtime: fs.statSync(path.join(this.sessionsDir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((s) => s.id);
  }

  /** @param {string} session @param {string} text */
  writeReceipt(session, text) {
    this.ensure();
    fs.writeFileSync(path.join(this.receiptsDir, `${safeName(session)}.txt`), text);
  }

  /** @param {string} session */
  readReceipt(session) {
    try { return fs.readFileSync(path.join(this.receiptsDir, `${safeName(session)}.txt`), 'utf8'); } catch { return null; }
  }

  /**
   * Keeps the agent's latest reply until its turn ends, for agents that report
   * it in a separate hook (Cursor). It is deleted when the turn ends.
   * @param {string} session @param {string} text
   */
  saveLastMessage(session, text) {
    fs.mkdirSync(path.join(this.dir, 'scratch'), { recursive: true });
    fs.writeFileSync(path.join(this.dir, 'scratch', `${safeName(session)}.last`), text);
  }

  /** Reads and deletes the saved reply. @param {string} session @returns {string|null} */
  takeLastMessage(session) {
    const file = path.join(this.dir, 'scratch', `${safeName(session)}.last`);
    try {
      const text = fs.readFileSync(file, 'utf8');
      fs.rmSync(file, { force: true });
      return text;
    } catch {
      return null;
    }
  }

  /** @param {unknown} err @param {string} where */
  logError(err, where) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      fs.appendFileSync(path.join(this.dir, 'errors.log'), `${new Date().toISOString()} [${where}] ${msg}\n`);
    } catch { /* never fail because logging failed */ }
  }
}

/**
 * Some agents report a tool's outcome after its hook (Antigravity writes the
 * exit code to its transcript a moment later). The adapter records the tool as
 * pending, and later appends a tool_result_amend. Readers see the amended
 * result in its original place, so the order of edits and tests stays true.
 * @param {any[]} events
 */
export function mergeAmendments(events) {
  const amends = new Map();
  for (const e of events) if (e.kind === 'tool_result_amend' && e.amends) amends.set(e.amends, e);
  if (!amends.size) return events;
  return events
    .filter((e) => e.kind !== 'tool_result_amend')
    .map((e) => {
      const a = e.kind === 'tool_result' && e.pending ? amends.get(e.toolUseId) : null;
      if (!a) return e;
      const { v, t, agent, session, turn, kind, amends: _id, ...fields } = a;
      return { ...e, ...fields, pending: false };
    });
}

/** @param {string} s */
function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'unknown';
}

/**
 * Turns learning notes on or off, for every project or (with root) for one,
 * keeping every other setting in ~/.keel/config.json as it is.
 * @param {'on'|'off'} mode
 * @param {string|null} root
 */
export function setLearnMode(mode, root) {
  const file = path.join(keelHome(), 'config.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* no config yet */ }
  if (root) {
    raw.projects = raw.projects || {};
    const key = path.resolve(root);
    raw.projects[key] = { ...(raw.projects[key] || {}), learn: { ...(raw.projects[key]?.learn || {}), mode } };
  } else {
    raw.learn = { ...(raw.learn || {}), mode };
  }
  fs.mkdirSync(keelHome(), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
}
