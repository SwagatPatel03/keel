// Agent-specific details that the shared scenarios do not cover: each one is a
// place where an adapter could break its agent rather than just miss a check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KEEL_EXEC, KEEL_PRE, makeWorld } from '../replay/harness.mjs';
import { cursor, copilot, antigravity, opencode } from './drivers.mjs';
import { KeelPlugin } from '../../opencode/plugin.mjs';

/** @param {string} event @param {string} agent @param {string} stdin @param {Record<string, string>} [env] */
function raw(event, agent, stdin, env = {}) {
  return spawnSync(KEEL_EXEC, [...KEEL_PRE, 'hook', event, agent], { input: stdin, encoding: 'utf8', env: { ...process.env, ...env } });
}

/** All stored session lines for a world's Keel home. @param {string} home */
function stored(home) {
  const projects = path.join(home, 'projects');
  if (!fs.existsSync(projects)) return '';
  return fs.readdirSync(projects).flatMap((p) => {
    const dir = path.join(projects, p, 'sessions');
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')) : [];
  }).join('');
}

test('Cursor: permission hooks always answer with valid JSON, even on broken input', () => {
  const w = makeWorld();
  for (const event of ['beforeShellExecution', 'beforeReadFile', 'preToolUse']) {
    for (const input of ['', 'not json', '{"hook_event_name": 5}']) {
      const r = raw(event, 'cursor', input, { KEEL_HOME: w.home });
      assert.equal(r.status, 0);
      assert.deepEqual(JSON.parse(r.stdout), { permission: 'allow' }, `${event} with ${JSON.stringify(input)}`);
    }
  }
  // Hooks that do not decide anything print nothing.
  assert.equal(raw('postToolUse', 'cursor', 'garbage', { KEEL_HOME: w.home }).stdout, '');
});

test('Cursor: a follow-up is marked [Keel], is not sized as a new prompt, and the email is never stored', async () => {
  const d = await cursor();
  await d.start();
  await d.prompt('The cart total is wrong, fix src/cart.mjs so the tests pass');
  fs.writeFileSync(path.join(d.repo, 'src', 'cart.mjs'), 'export function total() { return 0; }\n');
  await d.edited('src/cart.mjs', 'export function total() { return 0; }\n');
  const back = await d.stop('Fixed it. All tests pass.');
  assert.match(String(back.sentBack), /^\[Keel\] Keel checked/);
  // Cursor delivers the follow-up as a new prompt: it must not start a new task.
  const follow = await d.prompt(String(back.sentBack));
  assert.equal(follow.silent, true);
  const lines = stored(d.home);
  assert.ok(!lines.includes('someone@example.com'), 'no email in Keel records');
  assert.match(lines, /"continuation":true/);
});

test('Copilot: Claude-style PascalCase payloads work too, and nothing is printed on broken input', () => {
  const w = makeWorld();
  const deny = raw('PreToolUse', 'copilot', JSON.stringify({ session_id: 's1', cwd: w.repo, hook_event_name: 'PreToolUse', tool_name: 'bash', tool_input: { command: 'rm -rf ~' } }), { KEEL_HOME: w.home });
  assert.equal(JSON.parse(deny.stdout).permissionDecision, 'deny');
  const junk = raw('preToolUse', 'copilot', '{{{', { KEEL_HOME: w.home });
  assert.equal(junk.status, 0, 'a crash would deny every tool in Copilot');
  assert.equal(junk.stdout, '');
});

test('Copilot: the follow-up reason starts with [Keel] and the next prompt is a continuation', async () => {
  const d = await copilot();
  await d.start();
  await d.prompt('The cart total is wrong, fix src/cart.mjs so the tests pass');
  await d.edited('src/cart.mjs', 'export function total() { return 0; }\n');
  const back = await d.stop('Fixed it. All tests pass.');
  assert.match(String(back.sentBack), /^\[Keel\] /);
  assert.equal((await d.prompt(String(back.sentBack))).silent, true);
  assert.match(stored(d.home), /"continuation":true/);
});

test('Antigravity: only the first model call after a stop starts a task; Keel\'s own send-back does not', async () => {
  const d = /** @type {any} */ (await antigravity());
  await d.start();
  const first = await d.prompt('Add a search bar to the products page that filters by name');
  assert.match(String(first.guidance), /sized as a feature/);
  // Later model calls in the same task add nothing and record no new prompt.
  assert.equal((await d.invocation()).silent, true);
  await d.edited('src/cart.mjs', 'export function total() { return 0; }\n');
  const back = await d.stop('Done. All tests pass.');
  assert.ok(back.sentBack, 'the evidence gate sends the agent back');
  assert.equal((await d.invocation()).silent, true, 'the send-back continues the same task');
  await d.stop('Sorry, the tests fail.');
  const next = await d.prompt('The checkout page crashes when the cart is empty');
  assert.match(String(next.guidance), /Learning note/, 'a prompt after a real stop is a new task');
  const starts = stored(d.home).split('\n').filter((l) => l.includes('"kind":"turn_start"'));
  assert.equal(starts.length, 2);
});

test('Antigravity: every hook prints valid JSON, even on broken input, so a tool is never blocked by a Keel failure', () => {
  const w = makeWorld();
  for (const event of ['PreToolUse', 'PostToolUse', 'PreInvocation', 'Stop', 'SessionStart']) {
    const r = raw(event, 'antigravity', 'not json', { KEEL_HOME: w.home });
    assert.equal(r.status, 0);
    // PreToolUse needs an explicit allow: agy 1.4.2 refused every tool when a hook answered {}.
    assert.deepEqual(JSON.parse(r.stdout), event === 'PreToolUse' ? { decision: 'allow' } : {}, event);
  }
});

test('OpenCode: hooks never throw on odd input, except the deliberate refusal', async () => {
  const w = makeWorld();
  const hooks = await KeelPlugin({ client: {}, directory: w.repo, worktree: w.repo });
  process.env.KEEL_HOME = w.home;
  try {
    await hooks['chat.message'](/** @type {any} */ ({}), /** @type {any} */ ({}));
    await hooks['tool.execute.after'](/** @type {any} */ ({}), /** @type {any} */ (null));
    await hooks['experimental.chat.system.transform'](/** @type {any} */ ({}), /** @type {any} */ ({}));
    await hooks.event(/** @type {any} */ ({ event: { type: 'session.idle', properties: { sessionID: 'x' } } }));
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 'x', callID: 'c' }, { args: { command: 'ls' } });
    await assert.rejects(hooks['tool.execute.before']({ tool: 'bash', sessionID: 'x', callID: 'c' }, { args: { command: 'rm -rf ~' } }), /Keel refused this command/);
  } finally {
    delete process.env.KEEL_HOME;
  }
});

test('OpenCode: guidance stays in the system prompt for the whole prompt, and is cleared when the agent stops', async () => {
  const d = await opencode();
  await d.start();
  const p = await d.prompt('Add a search bar to the products page that filters by name');
  assert.match(String(p.guidance), /sized as a feature/);
  await d.stop('Here is the plan: 1. a 2. b 3. c');
  const after = await d.prompt('Rename total to cartTotal in src/cart.mjs');
  assert.equal(after.guidance, null);
});
