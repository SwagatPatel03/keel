import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { excerpt, maskSecrets } from '../../src/redact.mjs';
import { tokensSince, roundTokens } from '../../src/tokens.mjs';
import { toEvent, errorLine } from '../../src/adapters/claude-code.mjs';
import { projectId } from '../../src/store.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'claude-code');

test('masks common secret shapes', () => {
  const text = 'OPENAI_API_KEY=sk-abc123def456ghi789 failed; Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef; password: hunter2; token ghp_ABCDEFGHIJKLMNOPQRSTUVWX';
  const out = maskSecrets(text);
  for (const secret of ['sk-abc123def456ghi789', 'eyJhbGciOiJIUzI1NiJ9abcdef', 'hunter2', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX']) {
    assert.ok(!out.includes(secret), `${secret} should be masked in: ${out}`);
  }
  assert.ok(out.includes('[secret]'));
});

test('keeps ordinary paths and messages readable', () => {
  assert.equal(excerpt('Error: Cannot find module src/components/checkout/CartSummary'), 'Error: Cannot find module src/components/checkout/CartSummary');
  assert.equal(excerpt('x'.repeat(300), 200).length, 200);
});

test('counts transcript tokens once per message, from a tool call onwards', () => {
  const transcript = path.join(fixtures, 'transcript-2.1.291.jsonl');
  assert.deepEqual(tokensSince(transcript), { total: 197505, output: 980, messages: 4 });
  assert.deepEqual(tokensSince(transcript, 'toolu_014NgXy1h3dsCaaHn8XHxU52'), { total: 99605, output: 399, messages: 2 });
  assert.equal(tokensSince(transcript, 'no-such-id'), null);
  assert.equal(tokensSince('missing.jsonl'), null);
  assert.equal(roundTokens(99605), '100,000');
  assert.equal(roundTokens(4140), '4,100');
});

test('maps every recorded Claude Code 2.1.291 payload to a canonical event', () => {
  const root = 'C:\\proj';
  const payloads = fs.readFileSync(path.join(fixtures, 'recorded-2.1.291.jsonl'), 'utf8').trim().split('\n')
    .map((l) => JSON.parse(l.replaceAll('<CWD>', root.replace(/\\/g, '\\\\'))));
  const events = payloads.map((p) => toEvent(p, root));
  assert.deepEqual(events.map((e) => e.kind), ['session_start', 'turn_start', 'tool_result', 'tool_result', 'tool_result', 'tool_result', 'tool_result', 'turn_end', 'session_end']);
  const [fail] = events.filter((e) => e.kind === 'tool_result' && !e.ok);
  assert.equal(fail.exitCode, 1);
  assert.equal(fail.isTest, true);
  assert.equal(fail.errorExcerpt, 'FAIL add(2,2)=0');
  assert.ok(fail.errorFingerprint);
  const editEv = events.find((e) => e.tool === 'Edit');
  assert.deepEqual(editEv.files, ['math.mjs']);
  assert.ok(editEv.originalHash);
  const passEv = events.find((e) => e.tool === 'Bash' && e.ok);
  assert.equal(passEv.exitCode, 0);
  assert.equal(passEv.isTest, true);
  assert.ok(events.every((e) => e.session === '3446219a-c041-4c88-9e27-38a9652fa3c8'));
  assert.equal(events[1].turn, 'd359c926-d9e5-425b-ad3f-36abcb176b11');
  assert.equal(events[1].prompt, undefined, 'the prompt text is never stored');
});

test('picks the telling line of an error', () => {
  const node = 'Exit code 1\nfile:///C:/proj/flaky.mjs:1\nthrow new Error("cart total is wrong");\n^\n\nError: cart total is wrong\n    at file:///C:/proj/flaky.mjs:1:7\n\nNode.js v24.14.0';
  assert.equal(errorLine(node), 'Error: cart total is wrong');
  assert.equal(errorLine('Exit code 2\nsrc/a.ts(3,1): error TS2304: Cannot find name x'), 'src/a.ts(3,1): error TS2304: Cannot find name x');
  assert.equal(errorLine('Exit code 1\nsomething odd'), 'something odd');
  assert.equal(errorLine('String to replace not found in file.'), 'String to replace not found in file.');
});

test('project ids are readable and stable', () => {
  assert.match(projectId('/home/a/My App'), /^my-app-[0-9a-f]{8}$/);
  assert.equal(projectId('/home/a/x'), projectId('/home/a/x/'));
});
