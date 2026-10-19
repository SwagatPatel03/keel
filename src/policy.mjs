// Shared, content-free policy for guards, checkpoints and workspace exports.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const READ_GUARD_GLOBS = [
  '.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', '*.jks', '*.asc', '*.gpg',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', 'credentials*', 'application_default_credentials.json',
  'client_secret*.json', 'service-account*.json', 'service_account*.json', 'secret', 'secrets', 'secret.*', 'secrets.*', 'credentials/**', 'secrets/**',
  '.netrc', '.git-credentials', '.npmrc', '.pypirc', '.htpasswd', 'auth.json', '.credentials.json',
  '.ssh/**', '.aws/**', '.azure/**', '.config/gcloud/**', '.gnupg/**', '.kube/**', '.docker/**',
];

export function isSensitivePath(file) {
  // Match Windows alternate streams and trailing-dot/space aliases too. A
  // lexical spelling must not turn .env into an apparently ordinary path.
  const p = String(file).replace(/\\/g, '/').split('/').map((part) => part.split(':')[0].replace(/[. ]+$/, '')).join('/');
  const base = p.split('/').pop() || '';
  const sensitiveDirectory = /(^|\/)(credentials|secrets|\.ssh|\.aws|\.azure|\.config\/gcloud|\.gnupg|\.kube|\.docker)(\/|$)/i.test(p);
  if (/^\.env\.(example|sample|template|dist|defaults)$/i.test(base) && !sensitiveDirectory) return false;
  return sensitiveDirectory
    || /^(\.env(rc)?(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks|asc|gpg)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|credentials(\..+)?|application_default_credentials\.json|client_secret.*\.json|service[-_]account.*\.json|secrets?(\..+)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.htpasswd|auth\.json|\.credentials\.json)$/i.test(base);
}

export function excludedPath(file) {
  return isSensitivePath(file) || /(^|\/)(\.git|\.keel|node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.next|\.nuxt|\.turbo|\.cache|dist|build|target|coverage|\.gradle)(\/|$)/i.test(String(file).replace(/\\/g, '/'))
    || /\.(sqlite|db|log)$/i.test(file);
}

export function within(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

// Resolve existing ancestors too: new files below a symlink/junction still
// inherit its destination. Callers must recheck immediately before writing.
export function resolvedPath(file, root) {
  const expanded = String(file).replace(/^~(?=[\\/]|$)/, os.homedir())
    .replace(/^\$HOME|^\$env:USERPROFILE|^%USERPROFILE%/i, os.homedir());
  let current = path.resolve(root, expanded);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  try { current = fs.realpathSync(current); } catch { /* missing root */ }
  return path.join(current, ...tail);
}

export function supervisorPath(file) {
  const home = process.env.KEEL_HOME || path.join(os.homedir(), '.keel');
  return within(home, file) || /[\\/](\.claude|\.codex|\.cursor|\.copilot|\.gemini)[\\/](hooks(?:[\\/]|\.json)|settings[^\\/]*\.json|config\.toml)/i.test(file)
    || /[\\/]\.gemini[\\/]config[\\/]hooks\.json$|[\\/]\.config[\\/]opencode[\\/]plugins[\\/]keel\.[cm]?js$/i.test(file);
}

export function relativeFile(root, file) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new Error('Invalid file path.');
  const abs = path.resolve(root, file);
  if (ambiguousWindowsPath(root, file)) throw new Error('Ambiguous Windows path requires manual review.');
  if (!within(root, abs) || !within(root, resolvedPath(file, root))) throw new Error('Path escapes the project or follows an external link.');
  return path.relative(root, abs).split(path.sep).join('/');
}

export function ambiguousWindowsPath(root, file) {
  if (process.platform !== 'win32') return false;
  return path.relative(root, path.resolve(root, file)).split(/[\\/]/).some((part) => part !== '..' && (/[<>:"|?*\x00-\x1f]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)));
}
