import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editorFrom, editorOffer, extensionInstalled } from '../../src/editor-offer.mjs';
import { keelHome } from '../../src/store.mjs';

const marker = () => path.join(keelHome(), 'editor-offer-shown');

function home(t, installed = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-editor-home-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [editor, name] of installed) fs.mkdirSync(path.join(dir, editor, 'extensions', name), { recursive: true });
  return dir;
}

test('Keel tells VS Code, Cursor and a plain terminal apart', () => {
  assert.equal(editorFrom({ CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', VSCODE_PID: '1' }), 'vscode');
  assert.equal(editorFrom({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: 'C:\\Program Files\\Microsoft VS Code\\Code.exe' }), 'vscode');
  assert.equal(editorFrom({ TERM_PROGRAM: 'vscode', VSCODE_GIT_ASKPASS_NODE: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper' }), 'cursor');
  assert.equal(editorFrom({ TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'x' }), 'cursor');
  assert.equal(editorFrom({ TERM_PROGRAM: 'iTerm.app' }), null);
  assert.equal(editorFrom({}), null);
});

test('an installed extension in any editor counts, and other publishers do not', (t) => {
  assert.equal(extensionInstalled(home(t, [['.cursor', 'swagatpatel.keel-0.7.0']])), true);
  assert.equal(extensionInstalled(home(t, [['.vscode', 'swagatpatel.keel-0.7.0-win32-x64']])), true);
  assert.equal(extensionInstalled(home(t, [['.vscode', 'swagatpatel.keeling-1.0.0'], ['.vscode', 'swagatpatel.workbench-companion-0.4.0']])), false);
  assert.equal(extensionInstalled(home(t)), false);
});

test('the offer appears once, only in an editor without the extension', (t) => {
  fs.rmSync(marker(), { force: true });
  t.after(() => fs.rmSync(marker(), { force: true }));
  const vscode = { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', VSCODE_PID: '1' };
  assert.equal(editorOffer({ env: {}, home: home(t) }), null, 'not outside an editor');
  assert.equal(editorOffer({ env: vscode, home: home(t, [['.vscode', 'swagatpatel.keel-0.7.0']]) }), null, 'not when installed');
  assert.equal(fs.existsSync(marker()), false, 'neither case uses up the one offer');
  const first = editorOffer({ env: vscode, home: home(t) });
  assert.match(first, /code --install-extension swagatpatel\.keel/);
  assert.match(first, /once/);
  assert.equal(editorOffer({ env: vscode, home: home(t) }), null, 'never twice');
  fs.rmSync(marker(), { force: true });
  assert.match(editorOffer({ env: { TERM_PROGRAM: 'vscode', CURSOR_TRACE_ID: 'x' }, home: home(t) }), /Cursor's sidebar.*cursor --install-extension/);
});
