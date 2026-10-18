// Where Keel runs from. Keel ships as plain JavaScript that Node.js runs, and
// as one compiled executable per platform (built with Bun by
// scripts/build-binaries.mjs). Inside a compiled executable the source files
// live on a virtual drive (B:/~BUN/root on Windows, /$bunfs/root elsewhere), so
// only the executable's own path is on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

/** Whether this module was loaded from a compiled Keel. @param {string} url import.meta.url */
export function isCompiled(url) {
  return typeof (/** @type {any} */ (globalThis).Bun) !== 'undefined' && /[\\/](~BUN|\$bunfs)[\\/]/i.test(decodeURIComponent(url));
}

/**
 * Keel's folder (the plugin root). Both editions keep their entry point in
 * bin/, so it is one level up from the script or the executable.
 * @param {string} entryUrl import.meta.url of a file in bin/
 */
export function keelRoot(entryUrl) {
  const dir = isCompiled(entryUrl) ? path.dirname(process.execPath) : path.dirname(fileURLToPath(entryUrl));
  return path.resolve(dir, '..');
}

/** The compiled executable's file name on this platform. @param {NodeJS.Platform} [platform] */
export function exeName(platform = process.platform) {
  return platform === 'win32' ? 'keel.exe' : 'keel';
}

/**
 * A path with no spaces in it, for agents that split hook commands on spaces.
 * On Windows this is the short (8.3) form of an existing path; elsewhere, or
 * when Windows has no short name for it, the path itself.
 * @param {string} p
 */
export function noSpacePath(p) {
  if (!p.includes(' ') || process.platform !== 'win32' || !fs.existsSync(p)) return p;
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %A in ("${p}") do @echo %~sA"`], { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true });
  const short = String(r.stdout || '').trim();
  return r.status === 0 && short && !short.includes(' ') ? short : p;
}

/**
 * How to start Keel again as a separate process, for background work: the
 * compiled executable itself, or node with bin/keel.mjs. Null inside another
 * program's runtime (such as the OpenCode plugin), where neither is known.
 * @param {string|null|undefined} root  Keel's folder.
 * @returns {{command: string, args: string[]}|null}
 */
export function selfSpawn(root) {
  const base = path.basename(process.execPath).toLowerCase();
  if (/^keel(\.exe)?$/.test(base)) return { command: process.execPath, args: [] };
  const script = root ? path.join(root, 'bin', 'keel.mjs') : null;
  if (/^node(\.exe)?$/.test(base) && script && fs.existsSync(script)) return { command: process.execPath, args: [script] };
  return null;
}

/**
 * The command a user types to run Keel from a terminal, for the Keel in
 * `root`: node with the script for the Node.js edition, or the executable.
 * @param {string|null|undefined} root
 */
export function terminalCommand(root) {
  if (!root) return 'keel';
  const script = path.join(root, 'bin', 'keel.mjs');
  if (fs.existsSync(script)) return `node "${script}"`;
  const exe = path.join(root, 'bin', exeName());
  if (fs.existsSync(exe)) {
    const p = noSpacePath(exe);
    // A quoted program path does not run in PowerShell, so quote only when needed.
    return p.includes(' ') ? `"${p}"` : p;
  }
  return `node "${script}"`;
}
