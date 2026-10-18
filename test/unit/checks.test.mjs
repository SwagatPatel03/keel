import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCommand, normaliseError, detectTestCommand, detectBuildCommand, runCheck } from '../../src/checks.mjs';

test('classifies test commands', () => {
  for (const cmd of ['npm test', 'npm run test -- --watch=false', 'pnpm test', 'npx vitest run', 'pytest -q', 'python -m pytest tests/', 'go test ./...', 'cargo test', 'node --test', 'node test.mjs', 'make test', 'cd app && yarn test']) {
    assert.equal(classifyCommand(cmd).isTest, true, cmd);
  }
});

test('classifies build commands and leaves other commands alone', () => {
  for (const cmd of ['npm run build', 'npx tsc --noEmit', 'cargo build', 'go vet ./...', 'eslint src']) {
    assert.deepEqual(classifyCommand(cmd), { isTest: false, isBuild: true }, cmd);
  }
  for (const cmd of ['ls -la', 'git status', 'cat package.json', 'node server.js']) {
    assert.deepEqual(classifyCommand(cmd), { isTest: false, isBuild: false }, cmd);
  }
});

test('normalised errors match across line numbers, timings and paths', () => {
  const a = 'Exit code 1\nTypeError: x is undefined\n    at total (C:\\Users\\a\\proj\\src\\cart.mjs:12:7)\n✖ failed after 31ms';
  const b = 'Exit code 1\nTypeError: x is undefined\n    at total (C:\\Users\\a\\proj\\src\\cart.mjs:14:3)\n✖ failed after 207ms';
  const c = 'Exit code 1\nReferenceError: y is not defined';
  assert.equal(normaliseError(a), normaliseError(b));
  assert.notEqual(normaliseError(a), normaliseError(c));
});

test('detects declared test and build commands', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-detect-'));
  assert.equal(detectTestCommand(dir), null);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  assert.equal(detectTestCommand(dir), null, 'npm placeholder script is not a test command');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.equal(detectTestCommand(dir), 'pnpm test');
  assert.equal(detectBuildCommand(dir), 'pnpm run build');
  assert.equal(detectTestCommand(dir, { testCommand: 'make check' }), 'make check');
});

test('runCheck reports pass, failure and timeout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-run-'));
  assert.equal(runCheck('node -e "process.exit(0)"', dir, 10).ok, true);
  const fail = runCheck('node -e "console.error(\'2 failing\'); process.exit(3)"', dir, 10);
  assert.equal(fail.ok, false);
  assert.equal(fail.exitCode, 3);
  assert.match(fail.excerpt, /2 failing/);
  const slow = runCheck('node -e "setTimeout(()=>{}, 5000)"', dir, 1);
  assert.equal(slow.ok, false);
  assert.equal(slow.timedOut, true);
});
