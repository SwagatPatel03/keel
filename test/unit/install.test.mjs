import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, uninstall, doctor, settingsFile, isInstalled } from '../../src/install.mjs';
import { runRules, checkRules } from '../../src/rules.mjs';

const KEEL = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-install-'));
  const project = path.join(home, 'some-project');
  fs.mkdirSync(project);
  return { home, project, o: { home, keelRoot: KEEL, env: { ...process.env, XDG_CONFIG_HOME: '', COPILOT_HOME: '' }, now: () => new Date('2026-10-18T10:00:00Z') } };
}

test('Cursor: Keel merges next to the user\'s own hooks, keeps a backup, and uninstall removes only Keel\'s entries', () => {
  const { home, o } = sandbox();
  const file = path.join(home, '.cursor', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = { version: 1, hooks: { stop: [{ command: './my-own-stop.sh' }], afterFileEdit: [{ command: 'prettier --write' }] } };
  fs.writeFileSync(file, JSON.stringify(mine));

  const msg = install('cursor', o);
  assert.match(msg, /Keel is now installed for Cursor in all your projects/);
  assert.match(msg, /has not been checked in a real session yet/);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.hooks.stop[0].command, './my-own-stop.sh', 'the user\'s hook stays first');
  assert.match(after.hooks.stop[1].command, /^node ".*\/bin\/keel\.mjs" hook stop cursor$/);
  assert.equal(after.hooks.afterFileEdit.length, 1);
  assert.equal(after.hooks.preToolUse[0].matcher.includes('Write'), true);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith('hooks.json.keel-backup-')), 'a backup was written');

  install('cursor', o);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.stop.length, 2, 'installing twice does not duplicate entries');
  assert.equal(isInstalled('cursor', o), true);

  assert.match(uninstall('cursor', o), /removed only its own entries/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks, mine.hooks);
  assert.equal(isInstalled('cursor', o), false);
});

test('Copilot CLI and OpenCode get Keel\'s own files; Antigravity gets a "keel" group next to the user\'s', () => {
  const { home, project, o } = sandbox();
  install('copilot', o);
  const cp = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'hooks', 'keel.json'), 'utf8'));
  assert.equal(cp.version, 1);
  assert.equal(cp.hooks.preToolUse[0].exec, process.execPath, 'the absolute Node.js path, with no shell');
  assert.deepEqual(cp.hooks.agentStop[0].args.slice(1), ['hook', 'agentStop', 'copilot']);

  install('opencode', o);
  const oc = fs.readFileSync(path.join(home, '.config', 'opencode', 'plugins', 'keel.js'), 'utf8');
  assert.match(oc, /export \{ KeelPlugin \} from "file:\/\/\/.*\/opencode\/plugin\.mjs";/);

  const agy = path.join(home, '.gemini', 'config', 'hooks.json');
  fs.mkdirSync(path.dirname(agy), { recursive: true });
  fs.writeFileSync(agy, JSON.stringify({ 'my-linter': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh' }] }] } }));
  install('antigravity', o);
  const g = JSON.parse(fs.readFileSync(agy, 'utf8'));
  assert.ok(g['my-linter'], 'the user\'s group is kept');
  assert.match(g.keel.Stop[0].command, /^node --import=file:\/\/\/\S+\/bin\/hook-import\.mjs -e 0 antigravity Stop$/);
  assert.doesNotMatch(g.keel.Stop[0].command, /["']/, 'no quote marks, which agy keeps literally');
  assert.equal(g.keel.Stop[0].timeout, 180);

  assert.deepEqual(fs.readdirSync(project), [], 'nothing is written inside a project');

  for (const agent of ['copilot', 'opencode', 'antigravity']) uninstall(agent, o);
  assert.equal(fs.existsSync(path.join(home, '.copilot', 'hooks', 'keel.json')), false);
  assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'keel.js')), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(agy, 'utf8'))), ['my-linter']);
});

test('the installer refuses a broken settings file instead of overwriting it, and an unknown agent', () => {
  const { home, o } = sandbox();
  const file = path.join(home, '.cursor', 'hooks.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => install('cursor', o), /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{ not json');
  assert.throws(() => settingsFile('windsurf', o), /cannot install into "windsurf"/);
});

test('the installer stops in plain words when Node.js does not run', () => {
  const { o } = sandbox();
  const msg = install('copilot', { ...o, nodePath: path.join(o.home, 'no-such-node.exe') });
  assert.match(msg, /Keel did not install into Copilot CLI, because:\n {2}- Node.js did not run from/);
});

test('doctor lists every agent, what Keel can do there, and which are checked live', () => {
  const { o } = sandbox();
  install('cursor', o);
  const text = doctor(o);
  assert.match(text, /Claude Code: installed as a plugin[\s\S]*Checked in a real session: yes/);
  assert.match(text, /Cursor: installed \(.*hooks\.json\)\n {2}Checked in a real session: not yet \(built from documentation\)\n {2}Dangerous commands: Keel asks you first\n {2}Plan-first, clarity and learning guidance: added with the first tool result of the prompt\n {2}Budget warnings and notices: kept in the receipt/);
  assert.match(text, /OpenCode: not installed; run keel install opencode[\s\S]*Budget warnings and notices: shown to you/);
});

test('a compiled Keel installs a copy of itself in Keel\'s home folder and points every hook at it', () => {
  const { home, o } = sandbox();
  const built = path.join(home, 'plugin cache', 'bin', process.platform === 'win32' ? 'keel.exe' : 'keel');
  fs.mkdirSync(path.dirname(built), { recursive: true });
  fs.writeFileSync(built, 'not really a program');
  const c = { ...o, exe: built, binDir: path.join(home, '.keel', 'bin') };
  const copy = path.join(c.binDir, path.basename(built));

  install('copilot', c);
  assert.equal(fs.readFileSync(copy, 'utf8'), 'not really a program', 'the executable is copied out of the plugin folder, which moves on updates');
  const cp = JSON.parse(fs.readFileSync(path.join(home, '.copilot', 'hooks', 'keel.json'), 'utf8'));
  assert.equal(path.resolve(cp.hooks.preToolUse[0].exec), path.resolve(copy));
  assert.deepEqual(cp.hooks.preToolUse[0].args, ['hook', 'preToolUse', 'copilot'], 'no Node.js and no script');

  install('cursor', c);
  const stop = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'hooks.json'), 'utf8')).hooks.stop;
  assert.match(stop[0].command, /[\\/]keel(\.exe)?"? hook stop cursor$/);
  assert.equal(isInstalled('cursor', c), true, 'uninstall recognises the compiled command');
  uninstall('cursor', c);
  assert.equal(isInstalled('cursor', c), false);

  install('antigravity', c);
  const agyStop = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'hooks.json'), 'utf8')).keel.Stop[0].command;
  assert.match(agyStop, /^\S+[\\/]keel(\.exe)? hook Stop antigravity$/, 'no spaces and no quote marks for agy');

  assert.throws(() => install('opencode', c), /OpenCode runs Keel's JavaScript itself/);
  assert.match(doctor(c), /This Keel: the compiled edition/);
  assert.doesNotMatch(doctor(c), /Node\.js did not run/);
});

test('keel rules recommends one AGENTS.md, downloads nothing, and changes CLAUDE.md only after a yes', async () => {
  const { project } = sandbox();
  assert.match(await runRules(project), /has no AGENTS\.md\. Create one/);

  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Rules\nUse tabs.\n');
  assert.match(await runRules(project), /Only Claude Code reads CLAUDE\.md\. Rename it to AGENTS\.md/);

  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Rules\nUse tabs.\n');
  fs.mkdirSync(path.join(project, '.github'));
  fs.writeFileSync(path.join(project, '.github', 'copilot-instructions.md'), 'x');
  const offer = await runRules(project);
  assert.match(offer, /Claude Code reads only CLAUDE\.md when it exists/);
  assert.match(offer, /- \.github\/copilot-instructions\.md \(GitHub Copilot\)/);
  assert.match(offer, /To add it, run keel rules --yes\./);
  assert.equal(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'), '# Rules\nUse tabs.\n', 'nothing written without a yes');

  assert.match(await runRules(project, { ask: async () => false }), /Nothing was changed\./);
  assert.match(await runRules(project, { ask: async () => true }), /Added @AGENTS\.md as the first line of CLAUDE\.md/);
  assert.equal(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n\n# Rules\nUse tabs.\n');
  assert.match(await runRules(project, { yes: true }), /loads it with @AGENTS\.md, so every agent reads the same rules/);
  assert.equal(checkRules(project).imports, true, 'running again adds nothing');
});

