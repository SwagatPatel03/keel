// Protected paths: secret files (ask on read and edit), git internals
// (refuse edits), and CI workflows, migrations and lockfiles (ask on edit).

import os from 'node:os';
import path from 'node:path';
import { isSensitivePath, resolvedPath, within, supervisorPath, ambiguousWindowsPath } from '../policy.mjs';

/**
 * @typedef {{severity: 'refuse'|'ask', rule: string, what: string, safer: string}} Finding
 */

const LOCKFILE = /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|cargo\.lock|poetry\.lock|pipfile\.lock|uv\.lock|gemfile\.lock|composer\.lock|go\.sum|pubspec\.lock|podfile\.lock)$/i;
const CI = /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml$|\.circleci\/|azure-pipelines\.ya?ml$|bitbucket-pipelines\.ya?ml$|jenkinsfile$)/i;
const MIGRATION = /(^|\/)(migrations?|db\/migrate|alembic\/versions|prisma\/migrations)\//i;
const GIT_INTERNAL = /(^|\/)\.git\//;

/**
 * Claude Code permission-rule globs for the reads Keel must see. The plugin's
 * Read hook runs only for these (its `if` field), so ordinary reads start no
 * Keel process. They cover every name SECRET_NAME and SECRET_DIR match, plus a
 * few harmless ones (such as .env.example) that checkPath then lets through;
 * test/unit/plugin-files.test.mjs keeps the two in step.
 */
export { READ_GUARD_GLOBS } from '../policy.mjs';

/**
 * @param {string} file  Path as given by the agent (absolute or relative).
 * @param {'read'|'edit'} op
 * @param {{root: string, protect?: string[], allow?: string[]}} ctx
 * @returns {Finding|null}
 */
export function checkPath(file, op, ctx) {
  if (!file) return null;
  if (ambiguousWindowsPath(ctx.root, file)) return { severity: 'refuse', rule: 'ambiguous-path', what: 'This Windows path uses an alternate stream, device name or ambiguous spelling.', safer: 'Use a normal project file path.' };
  const norm = normalise(file, ctx.root);
  const base = norm.split('/').pop() || '';
  const resolved = resolvedPath(file, ctx.root);
  if (op === 'edit' && supervisorPath(resolved)) return { severity: 'refuse', rule: 'keel-policy', what: 'This changes host policy or hook configuration.', safer: 'Change policy through the host interface.' };
  if (op === 'edit' && !within(ctx.root, resolved) && within(ctx.root, path.resolve(ctx.root, file))) return { severity: 'refuse', rule: 'path-escape', what: 'This path follows a link outside the project.', safer: 'Use a project file without external links.' };
  if (matchesAny(norm, ctx.allow) && !isSensitivePath(resolved)) return null;

  if (isSensitivePath(norm) || isSensitivePath(resolved)) {
    return {
      severity: 'ask',
      rule: 'secret-file',
      what: op === 'read'
        ? `Claude wants to read ${display(file)}, which can hold secret keys or passwords. Anything it reads is sent to the model provider.`
        : `Claude wants to change ${display(file)}, which can hold secret keys or passwords.`,
      safer: op === 'read' ? 'If Claude only needs the names of the settings, it can read .env.example instead.' : 'You may prefer to edit this file yourself.',
    };
  }
  if (op === 'edit' && GIT_INTERNAL.test(norm)) {
    return { severity: 'refuse', rule: 'git-internals', what: `Editing ${display(file)} changes git's own records directly and can corrupt the repository.`, safer: 'Use git commands instead.' };
  }
  if (op === 'edit' && LOCKFILE.test(base)) {
    return { severity: 'ask', rule: 'lockfile', what: `Claude wants to edit ${display(file)} by hand. Lockfiles should be changed by the package manager, or installs can break.`, safer: 'Safer: run the package manager (for example npm install <package>) and let it update the lockfile.' };
  }
  if (op === 'edit' && CI.test(norm)) {
    return { severity: 'ask', rule: 'ci-workflow', what: `Claude wants to change ${display(file)}, a CI workflow that runs on every push and may deploy or use secrets.`, safer: 'Check the change before it is pushed.' };
  }
  if (op === 'edit' && MIGRATION.test(norm)) {
    return { severity: 'ask', rule: 'migration', what: `Claude wants to change ${display(file)}, a database migration. Editing one that has already run can leave databases out of step.`, safer: 'Safer: add a new migration instead of editing an existing one.' };
  }
  if (matchesAny(norm, ctx.protect)) {
    return { severity: 'ask', rule: 'protected-path', what: `Claude wants to ${op === 'read' ? 'read' : 'change'} ${display(file)}, which is on your protected list.`, safer: '' };
  }
  return null;
}

/** Project-relative path with forward slashes; paths in the home folder keep a ~/ prefix. */
function normalise(file, root) {
  let p = String(file).replace(/^["']|["']$/g, '');
  p = p.replace(/^~(?=[\\/]|$)/, os.homedir()).replace(/^\$HOME|^\$env:USERPROFILE|^%USERPROFILE%/i, os.homedir());
  const abs = path.resolve(root || '.', p);
  const rel = path.relative(root || '.', abs);
  const home = path.relative(os.homedir(), abs);
  const out = !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : !home.startsWith('..') && !path.isAbsolute(home) ? `~/${home}` : abs;
  return out.split(path.sep).join('/');
}

/** @param {string} file */
function display(file) {
  return String(file).split(/[\\/]/).slice(-2).join('/');
}

/** Simple globs: * within a segment, ** across segments (a trailing ** covers everything below). */
function matchesAny(p, patterns = []) {
  return patterns.some((g) => globToRegExp(g).test(p));
}

/** @param {string} glob */
export function globToRegExp(glob) {
  const esc = String(glob).replace(/\\/g, '/').replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(.*/)?').replace(/\u0001/g, '.*');
  return new RegExp(`(^|/)${esc}$`, 'i');
}
