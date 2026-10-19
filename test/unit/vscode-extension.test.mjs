// The VS Code extension, run against a real Keel project with a small stand-in
// for VS Code's API. It drives the commands a person would click and checks
// what happens to the files.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { ProjectStore } from '../../src/store.mjs';
import { handle } from '../../src/handlers.mjs';
import { makeEvent } from '../../src/events.mjs';
import { Shadow } from '../../src/checkpoint.mjs';

const require = createRequire(import.meta.url);

/** A Keel session in which the agent changed a.txt and created new.txt. */
function session(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-vscode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (f, v) => fs.writeFileSync(path.join(root, f), v);
  put('a.txt', 'original\n');
  put('keep.txt', 'untouched\n');
  const store = new ProjectStore(root);
  const shadow = new Shadow(store);
  const where = { agent: 'claude-code', session: 's1', turn: 't1' };
  store.append(makeEvent('session_start', where, {}));
  store.append(makeEvent('turn_start', where, { n: 1, checkpoint: shadow.snapshot('s1', 'start') }));
  for (const [id, tool, file, text] of [['e1', 'Edit', 'a.txt', 'agent line\n'], ['w1', 'Write', 'new.txt', 'made by the agent\n']]) {
    const ctx = { store, transcriptPath: null, lastMessage: null, toolInput: { file_path: path.join(root, file) } };
    handle(makeEvent('tool_call', where, { tool, toolUseId: id }), ctx);
    put(file, text);
    handle(makeEvent('tool_result', where, { tool, toolUseId: id, ok: true, files: [file] }), ctx);
  }
  store.append(makeEvent('turn_end', where, { checkpoint: shadow.snapshot('s1', 'end'), changedFiles: 2 }));
  return { root, read: (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), 'utf8') : null) };
}

/** Just enough of VS Code's API for the extension. `answers` plays the person. */
function fakeVscode(root, answers) {
  const commands = new Map();
  const shown = [];
  class EventEmitter {
    constructor() { this.fns = []; this.event = (fn) => { this.fns.push(fn); return { dispose() {} }; }; }
    fire(v) { for (const fn of this.fns) fn(v); }
    dispose() {}
  }
  const Uri = {
    file: (p) => ({ scheme: 'file', fsPath: p, path: p.replace(/\\/g, '/'), query: '' }),
    from: (o) => ({ query: '', ...o }),
  };
  const folder = { uri: Uri.file(root), name: path.basename(root), index: 0 };
  const statusItem = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  const treeView = { dispose() {} };
  let webview = null;
  const message = (kind) => async (text, ...rest) => {
    shown.push({ kind, text, rest });
    const buttons = rest.filter((r) => typeof r === 'string');
    return answers[kind]?.(text, buttons, rest[0]);
  };
  const vscode = {
    EventEmitter, Uri,
    ThemeColor: class { constructor(id) { this.id = id; } },
    MarkdownString: class { constructor() { this.value = ''; } appendMarkdown(s) { this.value += s; return this; } },
    TreeItem: class { constructor(resourceUri, state) { this.resourceUri = resourceUri; this.state = state; } },
    TreeItemCollapsibleState: { None: 0 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ProgressLocation: { Notification: 15 },
    window: {
      activeTextEditor: undefined,
      createStatusBarItem: () => statusItem,
      createTreeView: (_id, o) => Object.assign(treeView, { provider: o.treeDataProvider }),
      registerWebviewViewProvider: (_id, provider) => { webview = provider; return { dispose() {} }; },
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showQuickPick: async (items, o) => { shown.push({ kind: 'pick', items, o }); return answers.pick?.(items); },
      withProgress: (_o, fn) => fn({ report() {} }),
      showTextDocument: async (doc) => { shown.push({ kind: 'doc', doc }); },
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
    },
    workspace: {
      workspaceFolders: [folder],
      getWorkspaceFolder: () => folder,
      registerTextDocumentContentProvider: (scheme, provider) => { vscode.providers[scheme] = provider; return { dispose() {} }; },
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      openTextDocument: async (uri) => ({ uri, text: await vscode.providers[uri.scheme].provideTextDocumentContent(uri) }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (id, ...args) => {
        shown.push({ kind: 'command', id, args });
        return commands.get(id)?.(...args);
      },
    },
    providers: {},
  };
  return { vscode, shown, statusItem, treeView, run: (id, ...a) => commands.get(id)(...a), webview: () => webview };
}

/** Loads extension.cjs with the stand-in in place of 'vscode'. */
function activate(t, fake) {
  const load = Module._load;
  Module._load = function (request, ...rest) { return request === 'vscode' ? fake.vscode : load.call(this, request, ...rest); };
  const file = require.resolve('../../vscode-extension/extension.cjs');
  delete require.cache[file];
  delete require.cache[require.resolve('../../vscode-extension/view.cjs')];
  let ext;
  try { ext = require(file); } finally { Module._load = load; }
  const context = { extensionPath: path.dirname(file), subscriptions: [] };
  ext.activate(context);
  t.after(() => { for (const s of context.subscriptions) s.dispose?.(); });
  return ext;
}

test('the extension reads the session and shows it in the status bar and the Changed Files view', async (t) => {
  const p = session(t);
  const fake = fakeVscode(p.root, {});
  activate(t, fake);
  await fake.run('keel.refresh');
  assert.equal(fake.statusItem.visible, true);
  assert.match(fake.statusItem.text, /Keel/);
  assert.equal(fake.statusItem.command, 'keel.focus', 'the status bar only opens the sidebar');
  const files = fake.treeView.provider.getChildren().map((f) => `${f.status} ${f.path}`);
  assert.deepEqual(files, ['M a.txt', 'A new.txt']);
  const item = fake.treeView.provider.getTreeItem(fake.treeView.provider.getChildren()[0]);
  assert.equal(item.description, '+1 −1');
  assert.equal(item.command.command, 'keel.openDiff');
});

test('the diff compares the file with how it was when the session started', async (t) => {
  const p = session(t);
  const fake = fakeVscode(p.root, {});
  activate(t, fake);
  await fake.run('keel.refresh');
  await fake.run('keel.openDiff', 'a.txt');
  const diff = fake.shown.find((s) => s.kind === 'command' && s.id === 'vscode.diff');
  assert.ok(diff, 'a diff opened');
  const [base, now] = diff.args;
  assert.equal(now.fsPath, path.join(p.root, 'a.txt'));
  assert.equal(await fake.vscode.providers['keel-base'].provideTextDocumentContent(base), 'original\n');
});

test('undo previews, asks, changes only the ticked files, and can be put back', async (t) => {
  const p = session(t);
  let confirmed = null;
  const fake = fakeVscode(p.root, {
    // The person unticks new.txt, keeping it.
    pick: (items) => items.filter((i) => i.label === 'a.txt'),
    warning: (text, buttons, opts) => { confirmed = { text, opts }; return buttons[0]; },
    info: (text, buttons) => (buttons.includes('Put back') ? 'Put back' : undefined),
  });
  activate(t, fake);
  await fake.run('keel.refresh');

  const pickAt = fake.shown.length;
  await fake.run('keel.previewUndo');
  const pick = fake.shown.slice(pickAt).find((s) => s.kind === 'pick');
  assert.deepEqual(pick.items.map((i) => [i.label, i.description, i.picked]), [
    ['a.txt', 'will go back to how it was', true],
    ['new.txt', 'will be deleted (it was new this session)', true],
  ]);
  assert.match(confirmed.text, /Undo Claude’s changes to 1 file\?/);
  assert.equal(confirmed.opts.modal, true);

  // The undo ran, and the person pressed Put back straight away.
  const notes = fake.shown.filter((s) => s.kind === 'info').map((s) => s.text);
  assert.match(notes[0], /undid the changes to 1 file/);
  assert.match(notes[1], /put back 1 file/);
  assert.equal(p.read('a.txt'), 'agent line\n');
  assert.equal(p.read('new.txt'), 'made by the agent\n');
  assert.equal(p.read('keep.txt'), 'untouched\n');
});

test('nothing changes when the person cancels the confirmation', async (t) => {
  const p = session(t);
  const fake = fakeVscode(p.root, { pick: (items) => items, warning: () => undefined });
  activate(t, fake);
  await fake.run('keel.refresh');
  await fake.run('keel.previewUndo');
  assert.equal(p.read('a.txt'), 'agent line\n');
  assert.equal(p.read('new.txt'), 'made by the agent\n');
});

test('undoing one file restores it, and the rest stay', async (t) => {
  const p = session(t);
  const fake = fakeVscode(p.root, { warning: (_t, buttons) => buttons[0] });
  activate(t, fake);
  await fake.run('keel.refresh');
  await fake.run('keel.restoreFile', { path: 'a.txt' });
  assert.equal(p.read('a.txt'), 'original\n');
  assert.equal(p.read('new.txt'), 'made by the agent\n');
});

test('Keel refuses to overwrite an edit the person made after the agent', async (t) => {
  const p = session(t);
  const fake = fakeVscode(p.root, { pick: (items) => items, warning: (_t, buttons) => buttons[0] });
  activate(t, fake);
  await fake.run('keel.refresh');
  fs.writeFileSync(path.join(p.root, 'a.txt'), 'my own edit\n');
  await fake.run('keel.previewUndo');
  assert.equal(p.read('a.txt'), 'my own edit\n');
  assert.equal(p.read('new.txt'), 'made by the agent\n');
  const warned = fake.shown.filter((s) => s.kind === 'warning').map((s) => s.text);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /will not undo this.*a\.txt.*Nothing was changed/);
});
