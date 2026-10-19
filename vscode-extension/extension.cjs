// Keel for VS Code and Cursor: a sidebar that shows what Keel recorded while
// an agent worked, the files it changed with diffs, and a careful undo.
//
// The extension draws only. Every reading and every change goes through the
// Keel command line that ships inside the extension (keel/bin/keel.mjs), run
// with the editor's own Node, so the numbers match what Keel shows in Claude
// Code and the extension needs nothing else installed. Nothing it does changes
// a file without showing what will change and asking first.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const vscode = require('vscode');
const { renderBody, renderPage, ago, budgetLabel } = require('./view.cjs');

const BASE_SCHEME = 'keel-base';
const RECEIPT_SCHEME = 'keel-receipt';
const VERDICT_WORD = { verified: 'Verified', failed: 'Checks failed', not_verified: 'Not verified' };

/** Keel's command line: the copy bundled at packaging time, or the repository's own while developing. */
function keelBin(extensionPath) {
  const bundled = path.join(extensionPath, 'keel', 'bin', 'keel.mjs');
  return fs.existsSync(bundled) ? bundled : path.join(extensionPath, '..', 'bin', 'keel.mjs');
}

/** Whether Keel is installed in Claude Code on this machine. */
function installedInClaude() {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
    return /"keel(-[a-z0-9-]+)?@keel"/.test(text);
  } catch {
    return false;
  }
}

/**
 * @typedef {{ code: number|null, stdout: string, stderr: string }} RunResult
 */

class Keel {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.bin = keelBin(context.extensionPath);
    /** @type {any} */ this.model = null;
    /** @type {string|null} */ this.error = null;
    /** @type {string|null} */ this.busy = null;
    /** @type {string|null} */ this.root = null;
    this.changed = new vscode.EventEmitter();
    this.refreshing = null;
    this.again = false;
    /** @type {fs.FSWatcher|null} */ this.watcher = null;
    this.watching = null;
    this.timer = null;
  }

  /** The project: the folder of the file in front, else the first open folder. */
  pickRoot() {
    const folders = vscode.workspace.workspaceFolders || [];
    const active = vscode.window.activeTextEditor?.document.uri;
    const folder = (active && vscode.workspace.getWorkspaceFolder(active)) || folders[0];
    return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : null;
  }

  /**
   * Runs Keel in the project with the editor's Node.
   * @param {string[]} args @param {number} [timeoutMs]
   * @returns {Promise<RunResult>}
   */
  run(args, timeoutMs = 60_000) {
    const root = this.root || this.pickRoot();
    return new Promise((resolve) => {
      execFile(process.execPath, [this.bin, ...args], {
        cwd: root || os.homedir(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_PROJECT_DIR: root || '' },
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || (error && !stdout ? error.message : '')) });
      });
    });
  }

  /** Reads Keel's summary again. Calls that arrive while one runs are folded into one more read. */
  refresh() {
    if (this.refreshing) { this.again = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.again = false;
        this.root = this.pickRoot();
        if (!this.root) { this.model = null; this.error = null; break; }
        const r = await this.run(['ui', this.root]);
        try {
          const m = JSON.parse(r.stdout);
          if (m.error) throw new Error(m.error);
          this.model = m;
          this.error = null;
        } catch (e) {
          this.error = (r.stderr || (e instanceof Error ? e.message : String(e))).trim().split('\n')[0].slice(0, 300);
        }
        this.watch();
      } while (this.again);
      this.refreshing = null;
      this.changed.fire();
    })();
    return this.refreshing;
  }

  /** Refreshes when Keel writes to this project's records, at most every half second. */
  watch() {
    const dir = this.model?.store?.dir && !this.disposed ? path.join(this.model.store.dir, 'sessions') : null;
    if (dir === this.watching) return;
    this.watcher?.close();
    this.watcher = null;
    this.watching = dir;
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      let pending = null;
      this.watcher = fs.watch(dir, () => {
        clearTimeout(pending);
        pending = setTimeout(() => { if (!this.disposed) this.refresh(); }, 500);
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; this.watching = null; });
    } catch {
      this.watcher = null;
    }
  }

  /** Shows a label in the sidebar while a longer step runs. @template T @param {string} label @param {() => Promise<T>} fn @returns {Promise<T>} */
  async working(label, fn) {
    this.busy = label;
    this.changed.fire();
    try {
      return await fn();
    } finally {
      this.busy = null;
      this.changed.fire();
    }
  }

  dispose() {
    this.disposed = true;
    this.watcher?.close();
    this.watcher = null;
    clearInterval(this.timer);
  }
}

/** The sidebar page. */
class OverviewView {
  /** @param {Keel} keel @param {vscode.ExtensionContext} context */
  constructor(keel, context) {
    this.keel = keel;
    this.context = context;
    /** @type {vscode.WebviewView|null} */ this.view = null;
    context.subscriptions.push(keel.changed.event(() => this.update()));
  }

  body() {
    const k = this.keel;
    return renderBody(k.model, {
      busy: k.busy,
      error: k.error,
      noFolder: !k.pickRoot(),
      keelFound: Boolean(k.model?.session) || installedInClaude(),
    });
  }

  /** @param {vscode.WebviewView} view */
  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderPage(this.body(), { nonce: crypto.randomBytes(16).toString('base64') });
    view.webview.onDidReceiveMessage((msg) => {
      const commands = {
        refresh: 'keel.refresh',
        verify: 'keel.verify',
        previewUndo: 'keel.previewUndo',
        receipt: 'keel.receipt',
        diff: 'keel.openDiff',
      };
      if (msg?.cmd === 'ready') return this.update();
      const id = commands[msg?.cmd];
      if (id) vscode.commands.executeCommand(id, msg.arg || undefined);
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.keel.refresh(); });
  }

  update() {
    this.view?.webview.postMessage({ type: 'body', html: this.body() });
  }
}

/** The changed files, as a native tree with file icons. */
class ChangesTree {
  /** @param {Keel} keel */
  constructor(keel) {
    this.keel = keel;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    keel.changed.event(() => this.emitter.fire(undefined));
  }

  getChildren() {
    return this.keel.model?.changes || [];
  }

  /** @param {{ path: string, status: 'A'|'M'|'D', added: number, removed: number }} f */
  getTreeItem(f) {
    const root = this.keel.root || '';
    const uri = vscode.Uri.file(path.join(root, f.path));
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    const dir = path.posix.dirname(f.path);
    const word = { A: 'Added', M: 'Changed', D: 'Deleted' }[f.status];
    item.description = `${dir === '.' ? '' : `${dir}  `}${f.status === 'D' ? 'deleted' : `+${f.added} −${f.removed}`}`;
    item.tooltip = new vscode.MarkdownString(`**${f.path}**\n\n${word} this session: ${f.added} ${f.added === 1 ? 'line' : 'lines'} added, ${f.removed} removed.\n\nClick to compare it with how it was when the session started.`);
    item.contextValue = 'keelChange';
    item.command = { command: 'keel.openDiff', title: 'Compare with the start of the session', arguments: [f.path] };
    return item;
  }
}

/** A file as it was when the session started, read from Keel's checkpoints. */
class BaseContent {
  /** @param {Keel} keel */
  constructor(keel) { this.keel = keel; }

  /** @param {vscode.Uri} uri */
  provideTextDocumentContent(uri) {
    const params = new URLSearchParams(uri.query);
    const shadow = params.get('store'), commit = params.get('at');
    const file = uri.path.replace(/^\//, '');
    if (!shadow || !commit || !/^[0-9a-f]{7,64}$/i.test(commit)) return '';
    return new Promise((resolve) => {
      execFile('git', ['--git-dir', shadow, 'show', `${commit}:${file}`], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        resolve(error ? '' : String(stdout));
      });
    });
  }
}

/** Read-only text documents for Keel's reports. */
class ReportContent {
  constructor() {
    /** @type {Map<string, string>} */ this.texts = new Map();
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
  }

  /** @param {string} name @param {string} text */
  async show(name, text) {
    const uri = vscode.Uri.from({ scheme: RECEIPT_SCHEME, path: `/${name}` });
    this.texts.set(uri.path, text);
    this.emitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** @param {vscode.Uri} uri */
  provideTextDocumentContent(uri) { return this.texts.get(uri.path) || ''; }
}

/** @param {any} entry  One file from an undo preview. */
function undoWord(entry) {
  if (entry.after == null) return 'will be deleted (it was new this session)';
  if (entry.before == null) return 'will be put back (it was deleted this session)';
  return 'will go back to how it was';
}

/**
 * Parses `keel revert --json`. A failed run returns its message instead.
 * @param {RunResult} r @returns {{ result?: any, problem?: string }}
 */
function parseRevert(r) {
  try {
    const result = JSON.parse(r.stdout);
    if (result && Array.isArray(result.entries)) return { result };
    return { problem: (result?.reasons || []).join(' ') || 'Keel gave no answer.' };
  } catch {
    return { problem: (r.stdout || r.stderr || 'Keel gave no answer.').trim().split('\n')[0] };
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const keel = new Keel(context);
  const overview = new OverviewView(keel, context);
  const changes = new ChangesTree(keel);
  const reports = new ReportContent();

  // The status bar entry opens the sidebar. It never changes anything.
  const status = vscode.window.createStatusBarItem('keel.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Keel';
  status.command = 'keel.focus';
  const drawStatus = () => {
    const m = keel.model;
    if (!m || !m.prompts) { status.hide(); return; }
    const v = m.verdict.value;
    const icon = v === 'verified' ? '$(pass)' : v === 'failed' ? '$(error)' : '$(circle-large-outline)';
    status.text = `${icon} Keel${m.task ? ` ${budgetLabel(m.task.fraction)}` : ''}`;
    status.backgroundColor = v === 'failed' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(`**Keel: ${VERDICT_WORD[v]}**${m.verdict.at ? ` (${ago(m.verdict.at)})` : ''}\n\n`);
    if (m.task) tip.appendMarkdown(`Budget: ${budgetLabel(m.task.fraction)} of this ${m.task.size} task used\n\n`);
    tip.appendMarkdown(`${m.changes.length} ${m.changes.length === 1 ? 'file' : 'files'} changed this session\n\nClick to open the Keel sidebar.`);
    status.tooltip = tip;
    status.show();
  };

  // A badge on Keel's sidebar icon while the latest checks have failed.
  const treeView = vscode.window.createTreeView('keel.changes', { treeDataProvider: changes, showCollapseAll: false });
  const drawBadges = () => {
    const m = keel.model;
    treeView.badge = m?.verdict?.value === 'failed' ? { value: 1, tooltip: 'Keel: the latest checks failed' } : undefined;
    treeView.description = m?.changes?.length ? `${m.changes.length}` : undefined;
    treeView.message = m && m.prompts && !m.changes.length ? 'No files changed this session.' : undefined;
  };
  keel.changed.event(() => { drawStatus(); drawBadges(); });

  /** Asks Keel for an undo preview of the whole session or some files. @param {string[]|null} files */
  const preview = (files) => keel.working('Preparing the undo preview', () => keel.run(['revert', '--session', keel.model.session, ...(files ? ['--files', files.join(',')] : []), '--dry-run', '--json']));

  /** Applies an undo the person confirmed, then offers to put it back. @param {string[]|null} files */
  const apply = async (files) => {
    const r = await keel.working('Undoing', () => keel.run(['revert', '--session', keel.model.session, ...(files ? ['--files', files.join(',')] : []), '--json']));
    const { result, problem } = parseRevert(r);
    await keel.refresh();
    if (problem || result.state !== 'applied') {
      const why = problem || result.conflicts.map((c) => `${c.path}: ${c.reason}`).join('; ');
      vscode.window.showErrorMessage(`Keel did not undo anything. ${why}`);
      return;
    }
    const n = result.entries.length;
    const pick = await vscode.window.showInformationMessage(`Keel undid the changes to ${n} ${n === 1 ? 'file' : 'files'}. It saved the files first, so you can put them back.`, 'Put back');
    if (pick === 'Put back') await vscode.commands.executeCommand('keel.putBack');
  };

  /** Shows why an undo cannot go ahead. @param {any} result @param {string|undefined} problem */
  const refuse = (result, problem) => {
    if (problem) { vscode.window.showErrorMessage(`Keel could not prepare the undo. ${problem}`); return true; }
    if (result.conflicts.length) {
      const list = result.conflicts.slice(0, 3).map((c) => `${c.path} (${c.reason})`).join('; ');
      vscode.window.showWarningMessage(`Keel will not undo this, because some files changed after Claude's edits and the undo would overwrite that work: ${list}. Nothing was changed.`);
      return true;
    }
    if (!result.entries.length) { vscode.window.showInformationMessage('There is nothing to undo. The files already match how they were when the session started.'); return true; }
    return false;
  };

  const needSession = () => {
    if (keel.model?.session) return true;
    vscode.window.showInformationMessage('Keel has no session for this project yet, so there is nothing to undo.');
    return false;
  };

  const commands = {
    'keel.focus': () => vscode.commands.executeCommand('keel.overview.focus'),
    'keel.refresh': () => keel.refresh(),

    'keel.openDiff': async (arg) => {
      const file = typeof arg === 'string' ? arg : arg?.path;
      const m = keel.model;
      if (!file || !m?.store?.base) return;
      const change = m.changes.find((c) => c.path === file);
      const base = vscode.Uri.from({ scheme: BASE_SCHEME, path: `/${file}`, query: new URLSearchParams({ store: m.store.shadow, at: m.store.base }).toString() });
      const now = vscode.Uri.file(path.join(keel.root, file));
      if (change?.status === 'D') {
        await vscode.window.showTextDocument(base, { preview: true });
        return;
      }
      await vscode.commands.executeCommand('vscode.diff', base, now, `${path.posix.basename(file)} (start of session ↔ now)`, { preview: true });
    },

    'keel.verify': async () => {
      if (!keel.root) return;
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Keel is running the project’s checks', cancellable: false },
        () => keel.working('Running the checks', () => keel.run(['verify', '--json'], 15 * 60_000)));
      let evidence = null;
      try { evidence = JSON.parse(r.stdout); } catch { /* shown below */ }
      await keel.refresh();
      const v = evidence?.verdict;
      const why = (evidence?.reasons || []).slice(0, 2).join(' ');
      if (v === 'verified') vscode.window.showInformationMessage('Keel: verified. The project’s checks passed.');
      else if (v === 'failed') vscode.window.showErrorMessage(`Keel: the checks failed. ${why}`);
      else vscode.window.showWarningMessage(`Keel: not verified. ${why || (r.stderr || '').trim().split('\n')[0]}`);
    },

    'keel.previewUndo': async () => {
      if (!needSession()) return;
      const { result, problem } = parseRevert(await preview(null));
      if (refuse(result, problem)) return;
      const items = result.entries.map((e) => ({ label: e.path, description: undoWord(e), picked: true }));
      const chosen = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: 'Undo Claude’s changes from this session',
        placeHolder: 'Nothing has changed yet. Untick any file you want to keep, then press Enter.',
        ignoreFocusOut: true,
      });
      if (!chosen || !chosen.length) return;
      const all = chosen.length === items.length;
      const files = all ? null : chosen.map((c) => c.label);
      if (files && files.some((f) => f.includes(','))) {
        vscode.window.showErrorMessage('Keel cannot undo a file whose name has a comma one file at a time. Undo the whole session instead.');
        return;
      }
      const n = chosen.length;
      const ok = await vscode.window.showWarningMessage(
        `Undo Claude’s changes to ${n} ${n === 1 ? 'file' : 'files'}?`,
        { modal: true, detail: `${chosen.slice(0, 8).map((c) => `• ${c.label}: ${c.description}`).join('\n')}${n > 8 ? `\n…and ${n - 8} more` : ''}\n\nKeel saves the current files first, so you can put them back afterwards.` },
        `Undo ${n} ${n === 1 ? 'file' : 'files'}`,
      );
      if (ok) await apply(files);
    },

    'keel.restoreFile': async (arg) => {
      if (!needSession()) return;
      const file = typeof arg === 'string' ? arg : arg?.path;
      if (!file) return;
      if (file.includes(',')) { vscode.window.showErrorMessage('Keel cannot undo a file whose name has a comma on its own. Use “Preview undo” for the whole session.'); return; }
      const { result, problem } = parseRevert(await preview([file]));
      if (refuse(result, problem)) return;
      const ok = await vscode.window.showWarningMessage(`Undo Claude’s changes to ${file}?`, { modal: true, detail: `The file ${undoWord(result.entries[0])}. Keel saves it first, so you can put it back.` }, 'Undo this file');
      if (ok) await apply([file]);
    },

    'keel.putBack': async () => {
      const r = await keel.working('Putting the files back', () => keel.run(['revert', 'undo', '--json']));
      const { result, problem } = parseRevert(r);
      await keel.refresh();
      if (problem || result.state !== 'applied') {
        vscode.window.showErrorMessage(`Keel could not put the files back. ${problem || result.conflicts.map((c) => `${c.path}: ${c.reason}`).join('; ')}`);
        return;
      }
      vscode.window.showInformationMessage(`Keel put back ${result.entries.length} ${result.entries.length === 1 ? 'file' : 'files'}.`);
    },

    'keel.receipt': async () => {
      const r = await keel.working('Writing the receipt', () => keel.run(['receipt']));
      await reports.show('Keel receipt.txt', r.stdout || r.stderr || 'Keel has no records for this project yet.');
    },
  };
  for (const [id, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  context.subscriptions.push(
    status,
    treeView,
    keel,
    vscode.window.registerWebviewViewProvider('keel.overview', overview, { webviewOptions: { retainContextWhenHidden: false } }),
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, new BaseContent(keel)),
    vscode.workspace.registerTextDocumentContentProvider(RECEIPT_SCHEME, reports),
    vscode.workspace.onDidChangeWorkspaceFolders(() => keel.refresh()),
    vscode.window.onDidChangeActiveTextEditor(() => { if (keel.pickRoot() !== keel.root) keel.refresh(); }),
    vscode.window.onDidChangeWindowState((s) => { if (s.focused) keel.refresh(); }),
  );

  // The watcher catches Keel's writes; this slower read also keeps the ages fresh.
  keel.timer = setInterval(() => { if (overview.view?.visible || status.text) keel.refresh(); }, 30_000);
  keel.refresh();
}

function deactivate() {}

module.exports = { activate, deactivate, undoWord, parseRevert, keelBin };
