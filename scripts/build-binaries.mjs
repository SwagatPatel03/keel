#!/usr/bin/env node
// Builds the compiled Keel plugins, one per platform, for people without
// Node.js. Bun compiles bin/keel.mjs into one executable per platform; this
// script then lays out a Claude Code plugin around each executable (hooks and
// skills that run it directly), zips it, and records each zip's SHA-256.
// Bun is needed only here, at build time; Keel itself has no dependencies.
//
//   node scripts/build-binaries.mjs                     build every platform into dist/
//   node scripts/build-binaries.mjs --targets linux-x64 build some platforms
//   node scripts/build-binaries.mjs --test              build this machine's platform and
//                                                       run the test suite against it
//   node scripts/build-binaries.mjs --base-url <url>    also write the platform entries into
//                                                       .claude-plugin/marketplace.json, with
//                                                       each zip at <url>/<name>.zip

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { binaryLauncher, claudeHooksText } from '../src/plugin-files.mjs';
import { zip } from './zip.mjs';
import { VERSION } from '../src/version.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/**
 * x64 builds use Bun's "baseline" targets, which also run on processors from
 * before 2013 that lack the newer instructions the default build needs.
 * @type {Record<string, {bun: string, exe: string, label: string, os: NodeJS.Platform, arch: string}>}
 */
export const TARGETS = {
  'windows-x64': { bun: 'bun-windows-x64-baseline', exe: 'keel.exe', label: 'Windows on Intel or AMD (x64)', os: 'win32', arch: 'x64' },
  'macos-arm64': { bun: 'bun-darwin-arm64', exe: 'keel', label: 'Mac with Apple silicon (M1 or newer)', os: 'darwin', arch: 'arm64' },
  'macos-x64': { bun: 'bun-darwin-x64-baseline', exe: 'keel', label: 'Mac with an Intel processor', os: 'darwin', arch: 'x64' },
  'linux-x64': { bun: 'bun-linux-x64-baseline', exe: 'keel', label: 'Linux on Intel or AMD (x64)', os: 'linux', arch: 'x64' },
  'linux-arm64': { bun: 'bun-linux-arm64', exe: 'keel', label: 'Linux on ARM (arm64)', os: 'linux', arch: 'arm64' },
};

/** The platform name for this machine, or null when Keel has no build for it. */
export function hostTarget() {
  return Object.keys(TARGETS).find((k) => TARGETS[k].os === process.platform && TARGETS[k].arch === process.arch) || null;
}

/** A skill that runs the executable instead of node. @param {string} text @param {string} exe */
export function binarySkill(text, exe) {
  return text
    // The executable's path is quoted (it may contain spaces), so the rule ends in a quote mark.
    .replace(/^allowed-tools: Bash\(node \*\)$/m, `allowed-tools: Bash(*/bin/${exe}" *)`)
    .replace(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/keel\.mjs"/g, `"\${CLAUDE_PLUGIN_ROOT}/bin/${exe}"`);
}

/** @param {string} dir @returns {string[]} files below dir, relative, with forward slashes */
function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full).map((f) => `${e.name}/${f}`) : [e.name];
  });
}

/** @param {string} name @param {string} version */
function build(name, version) {
  const t = TARGETS[name];
  const dir = path.join(DIST, `keel-${name}`);
  if (!TARGETS[name] || path.dirname(path.resolve(dir)) !== path.resolve(DIST)) throw new Error('Build output must be a known platform directory within dist.');
  fs.rmSync(dir, { recursive: true, force: true });
  const exe = path.join(dir, 'bin', t.exe);
  // Relative paths from the repository root, so a space in the path cannot split an argument.
  const res = spawnSync('bun', ['build', '--compile', '--minify', `--target=${t.bun}`, 'bin/keel.mjs', '--outfile', path.relative(ROOT, exe)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (res.status !== 0 || !fs.existsSync(exe)) throw new Error(`Bun could not build ${name}:\n${res.stderr || res.stdout}`);

  const write = (/** @type {string} */ rel, /** @type {string} */ text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  // The manifest keeps the name "keel", so the commands stay /keel:revert and
  // so on in every edition; only the marketplace entry carries the platform.
  write('.claude-plugin/plugin.json', `${JSON.stringify({
    name: 'keel',
    version,
    description: `Keel for ${t.label}, with no Node.js needed. Reports independent check evidence, guards dangerous commands and secret files, stops error loops, and provides selective reversible recovery. Plugin enforcement is best effort. Install only one Keel plugin.`,
    author: { name: 'Swagat Swaroop Patel' },
    license: 'MIT',
    types: './types/index.d.ts',
  }, null, 2)}\n`);
  write('hooks/hooks.json', claudeHooksText(binaryLauncher(`bin/${t.exe}`)));
  // Keel's strip and pane inside Claude Code, and the state contract they declare.
  for (const rel of ['hooks/keel-ui.tsx', 'types/index.d.ts']) write(rel, fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  for (const rel of listFiles(path.join(ROOT, 'skills'))) {
    write(`skills/${rel}`, binarySkill(fs.readFileSync(path.join(ROOT, 'skills', rel), 'utf8'), t.exe));
  }
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  write('README.md', `# Keel for ${t.label}\n\nThis is Keel compiled into one program, so it needs no Node.js. It is the same Keel as the \`keel\` plugin; install only one of them. See the main README for what Keel does: https://github.com/SwagatPatel03/keel (the Keel repository).\n`);

  const files = listFiles(dir).map((rel) => ({ name: rel, data: fs.readFileSync(path.join(dir, rel)), mode: rel === `bin/${t.exe}` ? 0o755 : 0o644 }));
  const archive = zip(files);
  const zipFile = path.join(DIST, `keel-${name}.zip`);
  fs.writeFileSync(zipFile, archive);
  return { name: `keel-${name}`, label: t.label, exe, zip: zipFile, bytes: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex') };
}

/** Adds or replaces the platform entries in Keel's marketplace file. @param {ReturnType<typeof build>[]} built @param {string} baseUrl */
function writeMarketplace(built, baseUrl) {
  const file = path.join(ROOT, '.claude-plugin', 'marketplace.json');
  const market = JSON.parse(fs.readFileSync(file, 'utf8'));
  const names = new Set(built.map((b) => b.name));
  market.plugins = market.plugins.filter((/** @type {any} */ p) => !names.has(p.name));
  for (const b of built) {
    market.plugins.push({
      name: b.name,
      source: { source: 'archive', url: `${baseUrl.replace(/\/$/, '')}/${b.name}.zip`, sha256: b.sha256 },
      description: `Keel for ${b.label}, for computers without Node.js. Install only one Keel plugin.`,
    });
  }
  fs.writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
}

function main() {
  const args = process.argv.slice(2);
  const opt = (/** @type {string} */ flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const testing = args.includes('--test');
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  if (version !== VERSION) throw new Error('Package and compiled runtime versions differ. Update src/version.mjs before building.');
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (bun.status !== 0) {
    console.error('Building the compiled Keel needs Bun (https://bun.sh). Install it, then run this again.');
    process.exit(1);
  }
  const host = hostTarget();
  const names = opt('--targets')?.split(',') || (testing ? [host] : Object.keys(TARGETS));
  for (const n of names) {
    if (!n || !TARGETS[n]) {
      console.error(`Unknown or unsupported platform "${n}". Choose from: ${Object.keys(TARGETS).join(', ')}.`);
      process.exit(1);
    }
  }
  fs.mkdirSync(DIST, { recursive: true });
  const built = names.map((n) => build(/** @type {string} */ (n), version));
  for (const b of built) console.log(`${b.name}: ${(b.bytes / 1048576).toFixed(1)} MB zip, sha256 ${b.sha256}`);
  fs.writeFileSync(path.join(DIST, 'release.json'), `${JSON.stringify({ version, bun: bun.stdout.trim(), plugins: built.map(({ name, label, bytes, sha256 }) => ({ name, label, bytes, sha256 })) }, null, 2)}\n`);

  const base = opt('--base-url');
  if (base) {
    writeMarketplace(built, base);
    console.log('Updated .claude-plugin/marketplace.json');
  }
  if (testing) {
    const exe = built.find((b) => b.name === `keel-${host}`)?.exe;
    const tests = ['test/unit/*.test.mjs', 'test/replay/*.test.mjs', 'test/conformance/*.test.mjs'];
    const run = spawnSync(process.execPath, ['--import', './test/isolate-home.mjs', '--test', ...tests], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, KEEL_TEST_EXE: exe } });
    process.exit(run.status ?? 1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
