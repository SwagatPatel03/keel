// Authentic VS Code / Cursor extension entry point for Keel.
// Wires src/ide-bridge.mjs to native VS Code workbench primitives:
//   - Bottom-right Status Bar item + rich Markdown hover card
//   - Native Sidebar TreeView (Task Budget & Plan, Checkpoints + Child Files, Guardrails)
//   - GitLens-style CodeLens above modified functions
//   - Error Lens-style inline gate failure decorations on offending lines
//   - QuickPick multi-select file cherry-picker & native diff editor

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');

/**
 * Dynamically imports Keel's ESM modules from the parent package.
 */
async function loadKeelModules() {
  const storeMod = await import('../src/store.mjs');
  const bridgeMod = await import('../src/ide-bridge.mjs');
  const tuiMod = await import('../src/tui.mjs');
  const txMod = await import('../src/transactions.mjs');
  return { ...storeMod, ...bridgeMod, ...tuiMod, ...txMod };
}

/**
 * @param {vscode.ExtensionContext} context
 */
async function activate(context) {
  const keel = await loadKeelModules();

  const getStore = () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    return new keel.ProjectStore(keel.resolveRoot(folder));
  };

  // 1. Bottom-Right Status Bar Pill + Rich Markdown Hover Card
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'keel.cherryPick';
  context.subscriptions.push(statusBarItem);

  // 2. Error Lens-Style Inline Gate Diagnostic Decoration Type
  const errorLensDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(248, 81, 73, 0.16)',
    overviewRulerColor: '#f85149',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });
  context.subscriptions.push(errorLensDecoration);

  // 3. Native Sidebar TreeDataProvider (`KEEL: GUARDRAILS & TIMELINE`)
  class KeelSidebarProvider {
    constructor() {
      this._onDidChangeTreeData = new vscode.EventEmitter();
      this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }

    refresh() {
      this._onDidChangeTreeData.fire(undefined);
    }

    getTreeItem(element) {
      const hasChildren = Array.isArray(element.children) && element.children.length > 0
        || Array.isArray(element.files) && element.files.length > 0;
      const item = new vscode.TreeItem(
        element.label,
        hasChildren ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
      );
      item.description = element.description || '';
      if (element.path) {
        item.contextValue = 'keelFile';
        item.command = {
          command: 'keel.compareWithBaseline',
          title: 'Compare with Baseline',
          arguments: [element.path],
        };
      }
      return item;
    }

    getChildren(element) {
      const store = getStore();
      const model = keel.buildSidebarTreeModel(store);
      if (!element) {
        return [model.budgetAndPlan, model.checkpoints, model.guardrails];
      }
      if (Array.isArray(element.children)) return element.children;
      if (Array.isArray(element.files)) return element.files;
      return [];
    }
  }

  const sidebarProvider = new KeelSidebarProvider();
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('keel.sidebarView', sidebarProvider)
  );

  // 4. GitLens-Style CodeLens Provider above modified functions
  class KeelCodeLensProvider {
    constructor() {
      this._onDidChangeCodeLenses = new vscode.EventEmitter();
      this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
    }

    refresh() {
      this._onDidChangeCodeLenses.fire();
    }

    provideCodeLenses(document) {
      const store = getStore();
      const lenses = keel.buildCodeLensModel(store, document.uri.fsPath, document.getText());
      const out = [];
      for (const entry of lenses) {
        const lineIndex = Math.max(0, entry.line - 1);
        const range = new vscode.Range(lineIndex, 0, lineIndex, 0);
        for (const cmd of entry.commands) {
          out.push(new vscode.CodeLens(range, {
            title: cmd.title,
            command: cmd.command,
            arguments: cmd.arguments,
          }));
        }
      }
      return out;
    }
  }

  const codeLensProvider = new KeelCodeLensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, codeLensProvider)
  );

  // Update Status Bar, Error Lens Decorations, TreeView, and CodeLens
  const updateAllSurfaces = () => {
    try {
      const store = getStore();
      const sbModel = keel.buildStatusBarModel(store);
      statusBarItem.text = sbModel.text;
      const md = new vscode.MarkdownString(sbModel.tooltipMarkdown);
      md.isTrusted = true;
      statusBarItem.tooltip = md;
      statusBarItem.backgroundColor = sbModel.severity === 'error'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : sbModel.severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
      statusBarItem.show();

      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme === 'file') {
        const decs = keel.buildErrorLensModel(store, editor.document.uri.fsPath);
        const ranges = decs.map((d) => {
          const lineIdx = Math.max(0, Math.min(editor.document.lineCount - 1, d.line - 1));
          const line = editor.document.lineAt(lineIdx);
          return {
            range: line.range,
            renderOptions: {
              after: {
                contentText: `   ${d.message}`,
                color: '#ff7b72',
                fontStyle: 'italic',
              },
            },
          };
        });
        editor.setDecorations(errorLensDecoration, ranges);
      }

      sidebarProvider.refresh();
      codeLensProvider.refresh();
    } catch {
      // Never interrupt the editor on background refresh
    }
  };

  // 5. Register Extension Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('keel.refresh', () => updateAllSurfaces()),

    vscode.commands.registerCommand('keel.revert', async () => {
      try {
        const store = getStore();
        const res = keel.sessionRevert(store, store.listSessions()[0]);
        updateAllSurfaces();
        const action = await vscode.window.showInformationMessage(
          `Keel: Reverted ${res.entries.length} file(s) to task baseline.`,
          'Undo Revert'
        );
        if (action === 'Undo Revert') {
          await vscode.commands.executeCommand('keel.undo');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Keel Revert: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('keel.undo', async () => {
      try {
        const store = getStore();
        const res = keel.undoTransaction(store);
        updateAllSurfaces();
        vscode.window.showInformationMessage(`Keel: Undid last transaction (${res.entries.length} file(s) restored).`);
      } catch (err) {
        vscode.window.showErrorMessage(`Keel Undo: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('keel.cherryPickFile', async (fileArg) => {
      try {
        const store = getStore();
        const activeFile = typeof fileArg === 'string'
          ? fileArg
          : vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!activeFile) return;
        const rel = path.isAbsolute(activeFile)
          ? path.relative(store.root, activeFile).replace(/\\/g, '/')
          : activeFile.replace(/\\/g, '/');
        const res = keel.cherryPickRevert(store, store.listSessions()[0], { files: [rel] });
        updateAllSurfaces();
        const action = await vscode.window.showInformationMessage(
          `Keel: Restored ${rel} from checkpoint (${res.entries.length} file updated).`,
          'Undo'
        );
        if (action === 'Undo') {
          await vscode.commands.executeCommand('keel.undo');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Keel Restore File: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('keel.cherryPick', async () => {
      try {
        const store = getStore();
        const cpData = keel.listSessionCheckpoints(store);
        if (!cpData.files.length) {
          vscode.window.showInformationMessage('Keel: No modified files in the current session to cherry-pick.');
          return;
        }
        const items = cpData.files.map((f) => ({
          label: `${f.status} ${f.path}`,
          description: `+${f.added} -${f.removed}`,
          picked: true,
          filePath: f.path,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select files to restore from the session baseline (Space to toggle, Enter to restore)',
        });
        if (!picked || !picked.length) return;
        const res = keel.cherryPickRevert(store, cpData.session, {
          files: picked.map((p) => p.filePath),
        });
        updateAllSurfaces();
        const action = await vscode.window.showInformationMessage(
          `Keel: Restored ${res.entries.length} cherry-picked file(s).`,
          'Undo'
        );
        if (action === 'Undo') {
          await vscode.commands.executeCommand('keel.undo');
        }
      } catch (err) {
        vscode.window.showErrorMessage(`Keel Cherry-Pick: ${err.message}`);
      }
    }),

    vscode.commands.registerCommand('keel.compareWithBaseline', async (fileArg) => {
      try {
        const store = getStore();
        const cpData = keel.listSessionCheckpoints(store);
        const rel = typeof fileArg === 'string'
          ? fileArg
          : vscode.window.activeTextEditor
            ? path.relative(store.root, vscode.window.activeTextEditor.document.uri.fsPath).replace(/\\/g, '/')
            : cpData.files[0]?.path;
        const entry = cpData.files.find((f) => f.path === rel);
        if (!entry) return;
        const tmpFile = path.join(os.tmpdir(), `keel-baseline-${path.basename(rel)}`);
        fs.writeFileSync(tmpFile, entry.beforeText || '', 'utf8');
        const leftUri = vscode.Uri.file(tmpFile);
        const rightUri = vscode.Uri.file(path.join(store.root, rel));
        await vscode.commands.executeCommand(
          'vscode.diff',
          leftUri,
          rightUri,
          `${rel} (Keel Baseline ↔ Working Tree)`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Keel Diff: ${err.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => updateAllSurfaces()),
    vscode.workspace.onDidSaveTextDocument(() => updateAllSurfaces())
  );

  updateAllSurfaces();
}

function deactivate() {}

module.exports = { activate, deactivate };
