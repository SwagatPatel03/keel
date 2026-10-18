import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_LAUNCHER, binaryLauncher, claudeHooks, claudeHooksText } from '../../src/plugin-files.mjs';
import { READ_GUARD_GLOBS, checkPath, globToRegExp } from '../../src/guard/paths.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ctx = { root: '/work/app' };
/** True when one of the plugin's Read filters covers the path. @param {string} p */
const filtered = (p) => READ_GUARD_GLOBS.some((g) => globToRegExp(g).test(p));

test('hooks/hooks.json is the generated file (run node scripts/plugin-files.mjs after a change)', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8').replace(/\r\n/g, '\n'), claudeHooksText(NODE_LAUNCHER));
});

test('every secret file the guard asks about is covered by a Read filter', () => {
  const secrets = ['.env', 'config/.env.local', '.env.production', 'certs/server.pem', 'tls.key', 'store.p12', 'a.pfx', 'release.keystore', 'x.jks',
    'key.asc', 'backup.gpg', 'id_rsa', 'id_ed25519.pub', 'id_ecdsa', 'id_dsa', 'credentials', 'credentials.json', 'client_secret_123.json',
    'service-account-prod.json', 'service_account.json', 'secrets.yaml', 'secret.json', 'secrets.toml', 'secrets.env', '.netrc', '.git-credentials',
    '.npmrc', '.pypirc', '.htpasswd', 'auth.json', '.credentials.json', '.ssh/config', '.aws/credentials', '.gnupg/pubring.kbx', '.kube/config', '.docker/config.json'];
  for (const s of secrets) {
    assert.equal(checkPath(s, 'read', ctx)?.rule, 'secret-file', `${s} is a secret file`);
    assert.ok(filtered(s), `${s} must start Keel's Read hook`);
  }
});

test('ordinary reads start no Keel process, and harmless extra matches are let through by the guard', () => {
  for (const p of ['src/cart.mjs', 'package.json', 'README.md', 'test/cart.test.mjs', 'src/keyboard.js', 'docs/secrets-guide.md']) {
    assert.equal(filtered(p), false, `${p} should not start a hook`);
  }
  for (const p of ['.env.example', '.env.sample']) {
    assert.ok(filtered(p));
    assert.equal(checkPath(p, 'read', ctx), null, `${p} is safe to read`);
  }
});

test('the Read filters are anchored at the filesystem root, so files outside the project are covered too', () => {
  const read = claudeHooks(NODE_LAUNCHER).hooks.PreToolUse.find((m) => m.matcher === 'Read');
  assert.ok(read);
  assert.equal(read.hooks.length, READ_GUARD_GLOBS.length);
  for (const h of read.hooks) assert.match(String(h.if), /^Read\(\/\/\*\*\/[^()]+\)$/);
  assert.ok(!claudeHooks(NODE_LAUNCHER).hooks.PreToolUse[0].matcher.split('|').includes('Read'), 'reads are no longer hooked unconditionally');
});

test('PostToolUse skips reads and searches but keeps every other tool, including AskUserQuestion', () => {
  const re = new RegExp(claudeHooks(NODE_LAUNCHER).hooks.PostToolUse[0].matcher);
  for (const t of ['Read', 'Glob', 'Grep']) assert.equal(re.test(t), false, t);
  for (const t of ['Bash', 'Edit', 'AskUserQuestion', 'ReadMcpResource', 'NotebookEdit', 'mcp__x__read']) assert.equal(re.test(t), true, t);
});

test('a platform plugin runs its own executable with the same hooks', () => {
  const hooks = claudeHooks(binaryLauncher('bin/keel.exe')).hooks;
  assert.deepEqual([hooks.Stop[0].hooks[0].command, hooks.Stop[0].hooks[0].args], ['${CLAUDE_PLUGIN_ROOT}/bin/keel.exe', ['hook', 'Stop']]);
});

test('a trailing ** in a protect pattern covers the files below it', () => {
  assert.equal(checkPath('secrets/prod/key.txt', 'edit', { root: '/w', protect: ['secrets/**'] })?.rule, 'protected-path');
  assert.equal(checkPath('infra/prod.tfvars', 'edit', { root: '/w', protect: ['infra/*.tfvars'] })?.rule, 'protected-path');
  assert.equal(checkPath('src/a.js', 'edit', { root: '/w', protect: ['secrets/**'] }), null);
});
