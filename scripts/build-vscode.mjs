// Builds the VS Code and Cursor extension in vscode-extension/.
//
//   node scripts/build-vscode.mjs              copies Keel in and packages keel-<version>.vsix
//   node scripts/build-vscode.mjs --copy-only  only copies Keel in (vsce runs this before packaging)
//
// The extension runs the Keel command line that ships inside it, so it works
// on its own: Keel's bin/ and src/ are copied to vscode-extension/keel/, which
// git ignores. While developing, the extension falls back to the repository's
// own bin/ and src/ when that copy is missing.

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(repo, 'vscode-extension');
const into = path.join(ext, 'keel');

fs.rmSync(into, { recursive: true, force: true });
fs.mkdirSync(path.join(into, 'bin'), { recursive: true });
// Only the JavaScript launcher: the compiled editions' binaries stay out.
for (const name of fs.readdirSync(path.join(repo, 'bin'))) {
  if (/\.(mjs|cjs)$/.test(name)) fs.copyFileSync(path.join(repo, 'bin', name), path.join(into, 'bin', name));
}
fs.cpSync(path.join(repo, 'src'), path.join(into, 'src'), { recursive: true });
fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(ext, 'LICENSE'));

const count = (dir) => fs.readdirSync(dir, { recursive: true }).length;
console.log(`Copied Keel into vscode-extension/keel (${count(into)} files).`);

if (!process.argv.includes('--copy-only')) {
  const { version } = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
  // vsce runs vscode:prepublish, which copies again; that is quick and keeps both paths the same.
  // One fixed command line (npx is a script on Windows, so it runs through the shell).
  execSync(`npx --yes @vscode/vsce@3.2.1 package --no-dependencies --out keel-${version}.vsix`, { cwd: ext, stdio: 'inherit' });
  console.log(`Built vscode-extension/keel-${version}.vsix`);
}
