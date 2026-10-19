// Per-turn checkpoints in a shadow git repository kept inside Keel's store.
//
// The shadow repository points its work tree at the user's project but keeps
// its own object store, index and refs, so the user's .git folder, branches and
// history are never read or changed, and folders without git work too. The
// project's .gitignore files are respected, and secrets and heavy folders are
// always skipped. The idea follows stepback and rewind-ai (git trees outside
// the user's history); this is an independent implementation.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditStore, readJson } from './workspace.mjs';
import { excludedPath, relativeFile } from './policy.mjs';

const ALWAYS_EXCLUDE = [
  '# Keel never snapshots these.',
  '.git/', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.mypy_cache/',
  '.next/', '.nuxt/', '.turbo/', '.cache/', 'dist/', 'build/', 'target/', 'coverage/', '.gradle/',
  '.env', '.env.*', '!.env.example', '*.pem', '*.key', '*.p12', '*.pfx', 'id_rsa*', 'id_ed25519*', '.npmrc', '.pypirc',
  '*.sqlite', '*.db', '*.log', '.DS_Store', 'Thumbs.db',
].join('\n') + '\n';

const SNAPSHOT_TIMEOUT_MS = 15000;
const indexCopies = new Map();
process.once('exit', () => { for (const [file, shared] of indexCopies) { try { fs.copyFileSync(file, shared); } catch {} } });

export class Shadow {
  /** @param {import('./store.mjs').ProjectStore} store */
  constructor(store) {
    this.store = store;
    this.gitDir = store.shadowDir;
    this.work = store.root;
  }

  init() {
    if (fs.existsSync(path.join(this.gitDir, 'HEAD'))) {
      if (!readJson(path.join(this.store.dir, 'checkpoint-audit.json'))) auditStore(this);
      return this;
    }
    fs.mkdirSync(this.gitDir, { recursive: true });
    this.git(['init', '--quiet']);
    const settings = {
      'core.bare': 'false',
      'core.autocrlf': 'false',
      'core.safecrlf': 'false',
      'core.longpaths': 'true',
      'core.quotepath': 'false',
      'core.fsmonitor': 'false',
      'commit.gpgsign': 'false',
      'gc.auto': '256',
    };
    for (const [k, v] of Object.entries(settings)) this.git(['config', k, v]);
    fs.mkdirSync(path.join(this.gitDir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(this.gitDir, 'info', 'exclude'), ALWAYS_EXCLUDE);
    auditStore(this);
    return this;
  }

  /**
   * Snapshots the project's files and returns the checkpoint commit.
   * @param {string} session
   * @param {string} label   Ref name under the session, e.g. "turn-3-start".
   * @param {string|null} [parent]
   * @returns {string|null}  Commit id, or null when the snapshot was skipped.
   */
  snapshot(session, label, parent = null) {
    this.init();
    const env = this.indexEnv(session);
    try {
      // Ignore files are only a convenience. Explicit selection is the security
      // boundary, including entries already present in an older index.
      const previous = parent || this.resolve(this.ref(session, 'latest'));
      const files = [...(previous ? this.listFiles(previous) : []), ...this.git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { env }).split('\0')];
      const selected = [...new Set(files)].filter((file) => {
        if (!file || excludedPath(file)) return false;
        try {
          relativeFile(this.work, file);
          const stat = fs.lstatSync(path.join(this.work, file));
          if (stat.isSymbolicLink()) throw new Error('Checkpoint contains a link requiring review.');
          return stat.isFile();
        } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
      });
      this.git(['read-tree', '--empty'], { env });
      // Raw bytes bypass .gitattributes, clean filters, encodings and CRLF
      // normalization. The captured source must be the source we actually test.
      const message = `keel ${label}`;
      const chunks = [Buffer.from(`commit ${this.ref(session, label)}\ncommitter keel <keel@localhost> ${Math.floor(Date.now() / 1000)} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n${parent ? `from ${parent}\n` : ''}deleteall\n`)];
      let bytes = 0;
      for (const file of selected) {
        relativeFile(this.work, file);
        const fd = fs.openSync(path.join(this.work, file), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error('Checkpoint input is not a regular file within the size limit.');
          const content = fs.readFileSync(fd); bytes += content.length;
          if (bytes > 256 * 1024 * 1024) throw new Error('Checkpoint exceeds the capture size limit.');
          const quoted = '"' + [...Buffer.from(file)].map((byte) => byte === 34 ? '\\"' : byte === 92 ? '\\\\' : byte < 32 || byte >= 127 ? '\\' + byte.toString(8).padStart(3, '0') : String.fromCharCode(byte)).join('') + '"';
          chunks.push(Buffer.from(`M ${stat.mode & 0o111 ? '100755' : '100644'} inline ${quoted}\ndata ${content.length}\n`), content, Buffer.from('\n'));
        } finally { fs.closeSync(fd); }
      }
      chunks.push(Buffer.from('\ndone\n'));
      this.git(['fast-import', '--quiet', '--force'], { input: Buffer.concat(chunks), timeout: SNAPSHOT_TIMEOUT_MS });
      const commit = this.resolve(this.ref(session, label));
      if (!commit) throw new Error('Checkpoint commit unavailable.');
      this.git(['update-ref', this.ref(session, 'latest'), commit]);
      return commit;
    } catch (err) {
      // Too slow or unreadable: skip this checkpoint rather than save a partial one.
      this.store.logError(err, `snapshot ${label}`);
      return null;
    }
  }

  /** @param {string} session @param {string} name */
  ref(session, name) {
    return `refs/keel/sessions/${refSafe(session)}/${refSafe(name)}`;
  }

  /** Marks a checkpoint as green (its checks passed) for the session and the project. */
  markGreen(session, commit) {
    this.git(['update-ref', this.ref(session, 'green'), commit]);
    this.git(['update-ref', 'refs/keel/green', commit]);
  }

  /** @param {string} ref @returns {string|null} */
  resolve(ref) {
    try { return this.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim() || null; } catch { return null; }
  }

  /** @param {string} commit @returns {Date|null} */
  commitDate(commit) {
    try { return new Date(Number(this.git(['show', '-s', '--format=%ct', commit]).trim()) * 1000); } catch { return null; }
  }

  /**
   * Files that differ between two checkpoints.
   * @returns {{status: string, path: string, oldPath?: string}[]}
   */
  diffNames(from, to) {
    const out = this.git(['diff', '--name-status', '-M', '-z', from, to]);
    const parts = out.split('\0').filter(Boolean);
    const list = [];
    for (let i = 0; i < parts.length;) {
      const status = parts[i][0];
      if (status === 'R' || status === 'C') {
        list.push({ status, oldPath: parts[i + 1], path: parts[i + 2] });
        i += 3;
      } else {
        list.push({ status, path: parts[i + 1] });
        i += 2;
      }
    }
    return list;
  }

  /** Every file path in a checkpoint. @param {string} commit */
  listFiles(commit) {
    return this.git(['ls-tree', '-r', '--name-only', '-z', commit], { maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(Boolean);
  }

  /** File content at a checkpoint, or null if it did not exist there. */
  show(commit, file) {
    if (excludedPath(file)) return null;
    try { return this.git(['show', `${commit}:${file}`], { maxBuffer: 8 * 1024 * 1024 }); } catch { return null; }
  }

  /**
   * Restores the project's files to a checkpoint. Saves the current state
   * first, so the restore can be undone.
   * @param {string} session
   * @param {string} target
   */
  restore(session, target) {
    throw new Error('Whole-project restore is disabled. Use session-scoped transactions with conflict preview.');
  }

  /**
   * Deletes old checkpoints: every session whose newest checkpoint is older
   * than keepDays, then, while the store is larger than maxBytes, the oldest
   * remaining sessions. The project's latest green checkpoint and the given
   * session are always kept. Git then drops what nothing points to any more.
   * @param {{keepDays?: number, maxBytes?: number, now?: number, keep?: string|null}} [o]
   * @returns {{removed: number, bytesBefore: number, bytesAfter: number}}
   */
  prune(o = {}) {
    const keepDays = o.keepDays ?? 30;
    const maxBytes = o.maxBytes ?? 1024 * 1024 * 1024;
    const now = o.now ?? Date.now();
    const bytesBefore = dirSize(this.gitDir);
    if (!fs.existsSync(path.join(this.gitDir, 'HEAD'))) return { removed: 0, bytesBefore, bytesAfter: bytesBefore };
    const keep = o.keep ? refSafe(o.keep) : null;
    /** @type {Map<string, {refs: string[], newest: number}>} */
    const sessions = new Map();
    for (const line of this.git(['for-each-ref', '--format=%(refname) %(committerdate:unix)', 'refs/keel/sessions']).split('\n').filter(Boolean)) {
      const [ref, when] = line.split(' ');
      const id = ref.split('/')[3];
      if (!id || id === keep) continue;
      const s = sessions.get(id) || { refs: [], newest: 0 };
      s.refs.push(ref);
      s.newest = Math.max(s.newest, Number(when) * 1000);
      sessions.set(id, s);
    }
    const oldestFirst = [...sessions.entries()].sort((a, b) => a[1].newest - b[1].newest);
    let removed = 0;
    const drop = (/** @type {[string, {refs: string[]}]} */ [id, s]) => {
      for (const ref of s.refs) this.git(['update-ref', '-d', ref], { allowFail: true });
      try { fs.rmSync(path.join(this.gitDir, `index-${id}`), { force: true }); } catch { /* in use */ }
      removed++;
    };
    const tidy = () => {
      this.git(['reflog', 'expire', '--expire=now', '--all'], { allowFail: true });
      this.git(['gc', '--prune=now', '--quiet'], { allowFail: true });
    };
    const cutoff = now - keepDays * 86400000;
    while (oldestFirst.length && oldestFirst[0][1].newest < cutoff) drop(/** @type {any} */ (oldestFirst.shift()));
    if (removed) tidy();
    // Still too big: drop the oldest half of what is left, at most three times.
    for (let round = 0; round < 3 && oldestFirst.length && dirSize(this.gitDir) > maxBytes; round++) {
      for (const entry of oldestFirst.splice(0, Math.max(1, Math.ceil(oldestFirst.length / 2)))) drop(entry);
      tidy();
    }
    return { removed, bytesBefore, bytesAfter: dirSize(this.gitDir) };
  }

  /** Each session gets its own index, seeded from the last one used, so snapshots stay incremental. */
  indexEnv(session) {
    const file = path.join(this.gitDir, `index-${refSafe(session)}`);
    const shared = path.join(this.gitDir, 'index');
    if (!fs.existsSync(file) && fs.existsSync(shared)) {
      try { fs.copyFileSync(shared, file); } catch { /* start fresh */ }
    }
    indexCopies.set(file, shared);
    return { GIT_INDEX_FILE: file };
  }

  /**
   * @param {string[]} args
   * @param {{env?: Record<string,string>, timeout?: number, allowFail?: boolean, maxBuffer?: number, input?: string|Buffer}} [opts]
   */
  git(args, opts = {}) {
    try {
      return execFileSync('git', [`--git-dir=${this.gitDir}`, `--work-tree=${this.work}`, ...args], {
        cwd: this.work,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        input: opts.input,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_ATTR_NOSYSTEM: '1', ...(opts.env || {}) },
        timeout: opts.timeout,
        maxBuffer: opts.maxBuffer || 32 * 1024 * 1024,
        windowsHide: true,
      });
    } catch (err) {
      if (opts.allowFail) return '';
      throw err;
    }
  }
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'keel', GIT_AUTHOR_EMAIL: 'keel@localhost',
  GIT_COMMITTER_NAME: 'keel', GIT_COMMITTER_EMAIL: 'keel@localhost',
};

/** Bytes used by a folder and everything in it. @param {string} dir */
function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else { try { total += fs.statSync(p).size; } catch { /* removed meanwhile */ } }
  }
  return total;
}

/** @param {string} s */
function refSafe(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[.]+/, '_').replace(/\.lock$/, '_lock').slice(0, 100);
}
