// Recognises test and build commands, finds a project's declared test command,
// and runs it with a time limit.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tailExcerpt } from './redact.mjs';
import { invocations } from './guard/shell.mjs';

const TEST_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
  /\b(npx|pnpm\s+exec|yarn|bunx)\s+(jest|vitest|mocha|ava|tap|playwright\s+test|cypress\s+run)\b/,
  /(^|[\s;&|(])(jest|vitest|mocha)(\s|$)/,
  /\bpytest\b/,
  /\bpython[0-9.]*(\.exe)?\s+-m\s+(pytest|unittest)\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+(test|nextest)\b/,
  /\bnode(\.exe)?\s+--test\b/,
  /\bnode(\.exe)?\s+\S*(test|spec)\S*\.(m?js|cjs)\b/,
  /\bdeno\s+test\b/,
  /\b(mvn|mvnw|gradle|gradlew)\b.*\btest\b/,
  /\bdotnet\s+test\b/,
  /\brspec\b/,
  /\bphpunit\b/,
  /\bmake\s+(test|check)\b/,
  /\b(tox|nox)\b/,
];

const BUILD_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|typecheck|type-check|lint|check)\b/,
  /(^|[\s;&|(])(npx\s+)?tsc\b/,
  /\bcargo\s+(build|check|clippy)\b/,
  /\bgo\s+(build|vet)\b/,
  /\b(vite|next|astro|nuxt)\s+build\b/,
  /\b(mvn|mvnw)\b.*\b(compile|package|verify|install)\b/,
  /\b(gradle|gradlew)\b.*\b(build|assemble)\b/,
  /\bdotnet\s+build\b/,
  /\b(eslint|ruff|mypy|pyright|flake8)\b/,
  /\bmake\b(?!\s+(test|check))/,
];

/** @param {string|null|undefined} command */
export function classifyCommand(command) {
  const commands = invocations(String(command || ''));
  const candidates = commands.filter((inv) => {
    if (['echo', 'printf', 'write-output', 'write-host', 'cat', 'type'].includes(inv.cmd)) return false;
    if (['node', 'python', 'python3', 'python3.12', 'python3.13'].includes(inv.cmd) && inv.args.some((arg) => ['-e', '--eval', '-c'].includes(arg))) return false;
    if (inv.args.some((arg) => ['--version', '--help'].includes(arg))) return false;
    return /^(npm|pnpm|yarn|bun|npx|bunx|node|python[0-9.]*|pytest|go|cargo|jest|vitest|mocha|ava|tap|playwright|cypress|deno|mvnw?|gradlew?|dotnet|rspec|phpunit|make|tox|nox|tsc|vite|next|astro|nuxt|eslint|ruff|mypy|pyright|flake8)$/.test(inv.cmd);
  }).map((inv) => inv.cmd + ' ' + inv.args.join(' '));
  const isTest = candidates.some((cmd) => TEST_PATTERNS.some((re) => re.test(cmd)));
  const isBuild = !isTest && candidates.some((cmd) => BUILD_PATTERNS.some((re) => re.test(cmd)));
  return { isTest, isBuild };
}

/**
 * Normalises an error so that the same failure produces the same fingerprint
 * even when line numbers, timings, paths or addresses differ.
 * @param {string} text
 */
export function normaliseError(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\b/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\b/g, '<time>')
    .replace(/([A-Za-z]:)?([\\/][^\s\\/:'"`()]+)+[\\/]?/g, (m) => '<path>/' + m.split(/[\\/]/).filter(Boolean).pop())
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds|m)\b/g, '<dur>')
    .replace(/\d+/g, '#')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .slice(0, 40)
    .join('\n')
    .slice(0, 2000);
}

/** @param {string} command */
export function normaliseCommand(command) {
  return String(command || '').replace(/\s+/g, ' ').trim();
}

const NPM_DEFAULT_TEST = /no test specified/;

/**
 * Finds the project's declared test command. A per-project setting wins.
 * @param {string} root
 * @param {{testCommand?: string}} [settings]
 * @returns {string|null}
 */
export function detectTestCommand(root, settings = {}) {
  if (settings.testCommand) return settings.testCommand;
  const pkg = readJson(path.join(root, 'package.json'));
  if (pkg?.scripts?.test && !NPM_DEFAULT_TEST.test(pkg.scripts.test)) return `${packageRunner(root)} test`;
  if (exists(root, 'pytest.ini') || exists(root, 'conftest.py') || fileHas(root, 'pyproject.toml', /\[tool\.pytest/) || fileHas(root, 'setup.cfg', /\[tool:pytest\]/) || fileHas(root, 'tox.ini', /\[pytest\]/)) {
    return 'python -m pytest -q';
  }
  if (exists(root, 'Cargo.toml')) return 'cargo test';
  if (exists(root, 'go.mod')) return 'go test ./...';
  if (fileHas(root, 'Makefile', /^test\s*:/m)) return 'make test';
  if (exists(root, 'pyproject.toml') && (exists(root, 'tests') || exists(root, 'test'))) return 'python -m pytest -q';
  return null;
}

/**
 * Finds the project's declared build or type-check command.
 * @param {string} root
 * @param {{buildCommand?: string}} [settings]
 * @returns {string|null}
 */
export function detectBuildCommand(root, settings = {}) {
  if (settings.buildCommand) return settings.buildCommand;
  const pkg = readJson(path.join(root, 'package.json'));
  for (const name of ['build', 'typecheck', 'type-check']) {
    if (pkg?.scripts?.[name]) return `${packageRunner(root)} run ${name}`;
  }
  if (exists(root, 'Cargo.toml')) return 'cargo build';
  if (exists(root, 'go.mod')) return 'go build ./...';
  return null;
}

/**
 * Runs one check command in the project folder with a time limit.
 * @param {string} command
 * @param {string} root
 * @param {number} timeoutSec
 */
export function runCheck(command, root, timeoutSec) {
  const started = Date.now();
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, CI: process.env.CI || '1', FORCE_COLOR: '0' };
  // Inherited from a parent `node --test`, this makes a nested test run report
  // to that parent and exit 0 even when tests fail.
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(command, {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
  const timedOut = /** @type {any} */ (res.error)?.code === 'ETIMEDOUT' || (res.signal != null && Date.now() - started >= timeoutSec * 1000 - 50);
  const output = `${res.stdout || ''}\n${res.stderr || ''}`;
  return {
    command,
    ok: timedOut || res.status == null ? null : res.status === 0,
    outcome: timedOut || res.status == null ? 'unknown' : res.status === 0 ? 'passed' : 'failed',
    reason: timedOut ? 'timeout' : res.status == null ? 'missing exit status' : null,
    exitCode: timedOut ? null : res.status,
    timedOut,
    durationMs: Date.now() - started,
    excerpt: tailExcerpt(output, 300),
  };
}

/** @param {string} root */
function packageRunner(root) {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun';
  return 'npm';
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** @param {string} root @param {string} name */
function exists(root, name) {
  return fs.existsSync(path.join(root, name));
}

/** @param {string} root @param {string} name @param {RegExp} re */
function fileHas(root, name, re) {
  try { return re.test(fs.readFileSync(path.join(root, name), 'utf8')); } catch { return false; }
}
