import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLoop } from '../../src/loop.mjs';

const fail = (fp, id, cmd = 'k1') => ({ kind: 'tool_result', ok: false, errorFingerprint: fp, toolUseId: id, commandKey: cmd, errorExcerpt: 'TypeError: boom', command: 'npm test' });
const pass = (cmd = 'k1') => ({ kind: 'tool_result', ok: true, commandKey: cmd, files: [] });
const edit = (file, h, orig = null, id = null) => ({ kind: 'tool_result', ok: true, files: [file], fileHash: h, originalHash: orig, toolUseId: id });

test('the same error three times is a loop, reported from its first occurrence', () => {
  const events = [fail('A', 't1'), { kind: 'turn_start' }, fail('A', 't2')];
  assert.equal(detectLoop(events, 3), null);
  events.push(fail('A', 't3'));
  const loop = detectLoop(events, 3);
  assert.equal(loop?.kind, 'error');
  assert.equal(loop?.count, 3);
  assert.equal(loop?.firstToolUseId, 't1');
});

test('different errors do not add up', () => {
  assert.equal(detectLoop([fail('A', 't1'), fail('B', 't2'), fail('A', 't3')], 3), null);
});

test('a success of the same command resets the count', () => {
  assert.equal(detectLoop([fail('A', 't1'), fail('A', 't2'), pass(), fail('A', 't3')], 3), null);
});

test('after Keel stops a loop, counting starts again', () => {
  const events = [fail('A', 't1'), fail('A', 't2'), fail('A', 't3'), { kind: 'loop', loop: { kind: 'error', fingerprint: 'A' } }, fail('A', 't4')];
  assert.equal(detectLoop(events, 3), null);
});

test('a file edited back and forth to the same content is a loop', () => {
  const events = [edit('src/a.js', 'B', 'A', 'e1'), edit('src/a.js', 'A'), edit('src/a.js', 'B')];
  assert.equal(detectLoop(events, 3), null);
  events.push(edit('src/a.js', 'A'));
  const loop = detectLoop(events, 3);
  assert.equal(loop?.kind, 'edit');
  assert.equal(loop?.file, 'src/a.js');
  assert.equal(loop?.firstToolUseId, 'e1');
});

test('steady progress on a file is not a loop', () => {
  assert.equal(detectLoop([edit('a', 'B', 'A'), edit('a', 'C'), edit('a', 'D'), edit('a', 'E')], 3), null);
});
