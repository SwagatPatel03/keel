// Keel's guard rule packs. Each rule looks at one parsed command and returns
// a finding with a severity, a plain explanation and a safer alternative.
// 'refuse' is for commands that cannot be undone and are almost never what a
// beginner wants; 'ask' is for commands that are sometimes needed.
//
// These packs are Keel's own, written from widely known destructive commands.
// They are not copied from any other guard.

import os from 'node:os';
import { isSensitivePath } from '../policy.mjs';
import path from 'node:path';

/**
 * @typedef {import('./shell.mjs').Invocation} Invocation
 * @typedef {{severity: 'refuse'|'ask', rule: string, pack: string, what: string, safer: string}} Finding
 * @typedef {{root: string}} RuleContext
 * @typedef {{pack: string, check: (inv: Invocation, ctx: RuleContext) => Omit<Finding, 'pack'>|null}} Rule
 */

// Folders that are safe to delete because tools rebuild them.
const REBUILDABLE = /^(\.\/)?(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|\.parcel-cache|coverage|target|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.venv|venv|tmp|temp|\.tmp)\/?$/i;

const has = (inv, ...names) => names.some((n) => inv.flags.has(n));
const recursive = (inv) => has(inv, 'r', 'R', 'recursive', 'recurse', 's');

/**
 * What deleting a target would do: 'catastrophic' (the drive, the home
 * folder or a system folder), 'project' (the project itself, everything in
 * it, or anything outside it), 'safe' (a rebuildable folder or a temp path),
 * or 'normal'.
 * @param {string} target @param {string} root
 */
export function targetKind(target, root) {
  const t = String(target).replace(/^["']|["']$/g, '').trim();
  if (!t) return 'normal';
  const home = os.homedir();
  if (/^(\/|\/\*|~|~\/|~\/\*|\$HOME\/?\*?|\$\{HOME\}\/?|\$env:USERPROFILE\\?|%USERPROFILE%\\?|[A-Za-z]:[\\/]?\*?|\\|\/\.\*|\.\.\/\.\.(\/.*)?)$/i.test(t)) return 'catastrophic';
  if (/^\/(bin|boot|dev|etc|lib|lib64|opt|proc|root|sbin|sys|usr|var|home|Users|System|Library|Applications)(\/\*?)?$/i.test(t)) return 'catastrophic';
  if (/^[A-Za-z]:[\\/](Windows|Program Files( \(x86\))?|Users|ProgramData)[\\/]?\*?$/i.test(t)) return 'catastrophic';
  const expanded = t.replace(/^~(?=[\\/])/, home).replace(/^\$HOME(?=\/)/, home);
  const abs = path.resolve(root, expanded);
  if (path.resolve(abs) === path.resolve(home)) return 'catastrophic';
  if (/^(\.|\.\/|\*|\.\/\*|\.\*)$/.test(t)) return 'project';
  // A target computed at run time ($(...), `...`, $VAR) cannot be judged in advance.
  if (/\$\(|`|\$\{?[A-Za-z_]/.test(t)) return 'normal';
  if (REBUILDABLE.test(t.replace(/\\/g, '/'))) return 'safe';
  const rel = path.relative(root, abs);
  if (rel === '') return 'project';
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    // Outside the project, only the system temp folder is safe to clear.
    return abs.startsWith(path.resolve(os.tmpdir()) + path.sep) ? 'safe' : 'outside';
  }
  if (REBUILDABLE.test(rel.split(path.sep).join('/'))) return 'safe';
  return 'normal';
}

/**
 * A finding for deleting the given targets recursively.
 * @param {string[]} targets @param {string} root @param {string} cmdText
 * @returns {Omit<Finding, 'pack'>|null}
 */
function deletion(targets, root, cmdText) {
  const kinds = targets.map((t) => ({ t, k: targetKind(t, root) }));
  const worst = kinds.find((x) => x.k === 'catastrophic') || kinds.find((x) => x.k === 'project') || kinds.find((x) => x.k === 'outside') || kinds.find((x) => x.k === 'normal');
  if (!worst) return null;
  if (worst.k === 'catastrophic') {
    return { severity: 'refuse', rule: 'delete-catastrophic', what: `${cmdText} would permanently delete ${worst.t === '/' || /^[A-Za-z]:/.test(worst.t) ? 'everything on the drive' : worst.t.startsWith('~') || /home|USERPROFILE/i.test(worst.t) ? 'your whole home folder' : `the system folder ${worst.t}`}. This cannot be undone.`, safer: 'Delete the specific folder you mean instead.' };
  }
  if (worst.k === 'project') {
    return { severity: 'ask', rule: 'delete-project', what: `${cmdText} would delete everything in this project, including files Keel does not checkpoint (such as .env).`, safer: 'Safer: delete only the specific files or folders that need to go.' };
  }
  if (worst.k === 'outside') {
    return { severity: 'ask', rule: 'delete-outside', what: `${cmdText} would delete ${worst.t}, which is outside this project, so Keel's checkpoints cannot bring it back.`, safer: 'Check that this path is really meant to be deleted.' };
  }
  return { severity: 'ask', rule: 'delete-folder', what: `${cmdText} would permanently delete the folder ${worst.t} and everything in it.`, safer: 'Keel saved a checkpoint first, so /keel:revert can bring back project files.' };
}

/** @type {Rule[]} */
export const RULES = [
  // ---------- core.filesystem ----------
  { pack: 'core.filesystem', check(inv, ctx) {
    if (inv.cmd !== 'rm' && inv.cmd !== 'rmdir' && inv.cmd !== 'unlink') return null;
    // Plain rmdir only removes empty folders, and unlink removes one file.
    if (!recursive(inv) || inv.cmd === 'unlink') {
      const bad = inv.positional.find((t) => targetKind(t, ctx.root) === 'catastrophic');
      return bad ? deletion([bad], ctx.root, `rm ${bad}`) : null;
    }
    return inv.positional.length ? deletion(inv.positional, ctx.root, `rm -r ${inv.positional.join(' ')}`) : null;
  } },
  { pack: 'core.filesystem', check(inv, ctx) {
    // Windows: del /s, rd /s, rmdir /s; PowerShell: Remove-Item -Recurse and its aliases.
    const winDel = ['del', 'erase', 'rd'].includes(inv.cmd) || (inv.cmd === 'rmdir' && has(inv, 's'));
    const psDel = ['remove-item', 'ri'].includes(inv.cmd) || (['rm', 'rmdir', 'del', 'erase', 'rd'].includes(inv.cmd) && has(inv, 'recurse'));
    if (!winDel && !psDel) return null;
    if (!(has(inv, 's', 'recurse', 'r'))) {
      const bad = inv.positional.find((t) => targetKind(t, ctx.root) === 'catastrophic');
      return bad ? deletion([bad], ctx.root, `${inv.cmd} ${bad}`) : null;
    }
    const targets = inv.positional.length ? inv.positional : ['.'];
    return deletion(targets, ctx.root, `${inv.cmd} ${targets.join(' ')} (recursive)`);
  } },
  { pack: 'core.filesystem', check(inv, ctx) {
    if (inv.cmd !== 'find' || !(inv.args.includes('-delete') || inv.args.some((a) => a === '-exec' || a === '-execdir'))) return null;
    const start = inv.positional[0] || '.';
    const kind = targetKind(start, ctx.root);
    if (kind === 'catastrophic') return { severity: 'refuse', rule: 'find-delete-catastrophic', what: `find ${start} -delete would delete matching files across ${start === '/' ? 'the whole drive' : 'your home folder'}.`, safer: 'Run find without -delete first to see what it matches, in a specific folder.' };
    if (!inv.args.includes('-delete')) return null;
    return kind === 'safe' ? null : { severity: 'ask', rule: 'find-delete', what: `find ${start} ... -delete deletes every file it matches, which can be more than intended.`, safer: 'Safer: run the same find without -delete first to see the list.' };
  } },
  { pack: 'core.filesystem', check(inv) {
    if (inv.cmd === 'dd' && inv.args.some((a) => /^of=\/dev\/(sd|hd|nvme|disk|mmcblk|xvd)/.test(a))) return { severity: 'refuse', rule: 'disk-overwrite', what: 'dd of=/dev/... overwrites a whole disk and destroys everything on it.', safer: 'Write to a file instead of a device.' };
    if (/^mkfs(\.|$)/.test(inv.cmd) || ['diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'wipefs', 'fdisk', 'parted', 'sgdisk'].includes(inv.cmd)) return { severity: 'refuse', rule: 'disk-format', what: `${inv.cmd} formats or repartitions a disk and destroys everything on it.`, safer: 'This is never needed for coding work; do it yourself if you really mean it.' };
    if (inv.cmd === 'format' && inv.positional.some((a) => /^[A-Za-z]:$/.test(a))) return { severity: 'refuse', rule: 'disk-format', what: `format ${inv.positional[0]} erases a whole drive.`, safer: 'This is never needed for coding work.' };
    if (inv.redirects.some((r) => /^\/dev\/(sd|hd|nvme|disk)/.test(r))) return { severity: 'refuse', rule: 'disk-overwrite', what: 'Redirecting output into a disk device overwrites it.', safer: 'Write to a file instead.' };
    if (inv.cmd === 'shred' && inv.positional.some((a) => a.startsWith('/dev/'))) return { severity: 'refuse', rule: 'disk-overwrite', what: 'shred on a device destroys the whole disk.', safer: 'Shred specific files instead.' };
    return null;
  } },
  { pack: 'core.filesystem', check(inv, ctx) {
    if ((inv.cmd === 'chmod' || inv.cmd === 'chown' || inv.cmd === 'chgrp') && recursive(inv)) {
      const target = inv.positional[inv.positional.length - 1];
      const kind = targetKind(target || '', ctx.root);
      if (kind === 'catastrophic') return { severity: 'refuse', rule: 'perm-catastrophic', what: `${inv.cmd} -R on ${target} changes permissions across the system or home folder and can break your computer.`, safer: 'Change permissions on the specific project folder instead.' };
    }
    if (inv.cmd === 'mv' && inv.positional.some((t) => targetKind(t, ctx.root) === 'catastrophic')) return { severity: 'refuse', rule: 'move-catastrophic', what: 'Moving the drive root or your home folder breaks your computer.', safer: 'Move the specific folder you mean.' };
    if (/:\(\)\s*\{\s*:\|:&\s*\};:/.test(inv.raw)) return { severity: 'refuse', rule: 'fork-bomb', what: 'This is a fork bomb; it freezes the computer.', safer: '' };
    return null;
  } },

  // ---------- core.git ----------
  { pack: 'core.git', check(inv) {
    if (inv.cmd !== 'git') return null;
    const [sub, ...rest] = inv.positional;
    const flags = inv.flags;
    if (sub === 'reset' && flags.has('hard')) return { severity: 'ask', rule: 'git-reset-hard', what: 'git reset --hard throws away all uncommitted changes in tracked files.', safer: 'Safer: git stash keeps the changes so you can get them back.' };
    if (sub === 'clean' && flags.has('f') && (flags.has('d') || flags.has('x') || flags.has('X'))) return { severity: 'ask', rule: 'git-clean', what: 'git clean -f deletes untracked files and folders, which git cannot bring back.', safer: 'Safer: run git clean -n first to see what it would delete.' };
    if (sub === 'push' && (flags.has('force') || flags.has('f') || rest.some((r) => /^\+/.test(r))) && !flags.has('force-with-lease') && !flags.has('force-if-includes')) return { severity: 'ask', rule: 'git-push-force', what: 'git push --force overwrites the remote branch and can delete other people\'s commits.', safer: 'Safer: git push --force-with-lease refuses if someone else has pushed.' };
    if (sub === 'push' && (flags.has('delete') || flags.has('d') || rest.some((r) => /^:/.test(r)))) return { severity: 'ask', rule: 'git-push-delete', what: 'This deletes a branch on the remote.', safer: 'Check the branch name first.' };
    if (sub === 'branch' && (flags.has('D') || (flags.has('d') && flags.has('f')) || (flags.has('delete') && flags.has('force')))) return { severity: 'ask', rule: 'git-branch-force-delete', what: 'git branch -D deletes a branch even if its work was never merged.', safer: 'Safer: git branch -d refuses to delete unmerged work.' };
    if ((sub === 'checkout' && (rest.includes('.') || inv.args.includes('--'))) || (sub === 'restore' && !flags.has('staged') && !flags.has('S') && rest.length)) return { severity: 'ask', rule: 'git-discard', what: `git ${sub} ${rest.join(' ')} throws away uncommitted changes in those files.`, safer: 'Safer: git stash keeps the changes so you can get them back.' };
    if (sub === 'stash' && (rest[0] === 'clear' || rest[0] === 'drop')) return { severity: 'ask', rule: 'git-stash-drop', what: `git stash ${rest[0]} deletes saved work for good.`, safer: 'Check git stash list first.' };
    if (sub === 'filter-branch' || sub === 'filter-repo') return { severity: 'ask', rule: 'git-rewrite-history', what: `git ${sub} rewrites the whole history of the repository.`, safer: 'Make a backup branch first.' };
    if ((sub === 'reflog' && rest[0] === 'expire') || (sub === 'gc' && inv.args.some((a) => /^--prune=now/.test(a))) || (sub === 'update-ref' && flags.has('d'))) return { severity: 'ask', rule: 'git-destroy-recovery', what: `git ${sub} ${rest.join(' ')} removes git's safety net for recovering lost commits.`, safer: 'This is rarely needed; skip it.' };
    return null;
  } },

  // ---------- secrets via the shell ----------
  { pack: 'core.secrets', check(inv) {
    const readers = ['cat', 'type', 'less', 'more', 'head', 'tail', 'bat', 'get-content', 'gc', 'grep', 'rg', 'awk', 'sed', 'source', '.', 'xxd', 'strings', 'select-string', 'sls', 'nl', 'base64', 'cp', 'copy', 'copy-item', 'scp', 'curl'];
    if (readers.includes(inv.cmd)) {
      const secret = inv.positional.find((a) => isSecretPath(a));
      const typed = inv.raw.trim().split(/\s+/)[0];
      if (secret) return { severity: 'ask', rule: 'secret-read-shell', what: `${typed} ${secret} would print or copy secret keys, and anything shown is sent to the model provider.`, safer: 'If only the setting names are needed, read .env.example instead.' };
    }
    if ((inv.cmd === 'printenv' || inv.cmd === 'env' || inv.cmd === 'set' || (inv.cmd === 'get-childitem' && inv.positional.some((p) => /^env:/i.test(p))) || (inv.cmd === 'gci' && inv.positional.some((p) => /^env:/i.test(p)))) && !inv.positional.some((p) => !/^env:?$/i.test(p))) {
      return { severity: 'ask', rule: 'env-dump', what: 'This prints every environment variable, including any API keys, into the conversation.', safer: 'Print only the variable you need, if it is not a secret.' };
    }
    if ((inv.cmd === 'echo' || inv.cmd === 'write-output' || inv.cmd === 'write-host' || inv.cmd === 'printf') && /\$(env:)?\{?[A-Za-z_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z_]*/i.test(inv.raw)) {
      return { severity: 'ask', rule: 'secret-echo', what: 'This prints a secret from an environment variable into the conversation.', safer: 'Check whether it is set without printing it, for example: test -n "$API_KEY" && echo set.' };
    }
    return null;
  } },

  // ---------- databases ----------
  { pack: 'database', check(inv) {
    const sql = /\b(drop\s+(database|schema|table|collection|index)|truncate(\s+table)?\s+\w|alter\s+table\s+\S+\s+drop\b)/i;
    const deleteAll = /\bdelete\s+from\s+[\w."`\[\]]+\s*(;|"|'|$)(?![\s\S]*\bwhere\b)/i;
    const dbClients = ['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'mongosh', 'mongo', 'cockroach', 'duckdb', 'clickhouse-client', 'supabase', 'turso', 'wrangler', 'prisma', 'npx', 'pnpx', 'bunx', 'node', 'python', 'python3'];
    if (dbClients.includes(inv.cmd) && (sql.test(inv.raw) || deleteAll.test(inv.raw))) {
      return { severity: 'ask', rule: 'sql-destructive', what: 'This SQL deletes a database, a table, a column or every row in a table.', safer: 'Make a backup or run it on a test database first.' };
    }
    const text = [inv.cmd, ...inv.args].join(' ').toLowerCase();
    if (/\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b.*(--force-reset|--accept-data-loss)|\b(rails|rake)\s+db:(drop|reset|schema:load)\b|\bdb:(drop|wipe|fresh)\b|\bmanage\.py\s+(flush|reset_db)\b|\bsupabase\s+db\s+reset\b|\bsequelize(-cli)?\s+db:drop\b|\bknex\s+migrate:rollback\b.*--all|\bmigrate:(fresh|reset)\b/.test(text)) {
      return { severity: 'ask', rule: 'db-reset', what: 'This resets or drops the database and deletes its data.', safer: 'Make sure this is a local test database, or back it up first.' };
    }
    if (inv.cmd === 'redis-cli' && inv.positional.some((p) => /^flush(all|db)$/i.test(p))) return { severity: 'ask', rule: 'redis-flush', what: 'redis-cli FLUSHALL deletes every key.', safer: 'Delete the specific keys instead.' };
    if ((inv.cmd === 'mongosh' || inv.cmd === 'mongo') && /dropDatabase\(|\.drop\(\)/.test(inv.raw)) return { severity: 'ask', rule: 'sql-destructive', what: 'This deletes a MongoDB database or collection.', safer: 'Back it up first.' };
    return null;
  } },

  // ---------- cloud and infrastructure ----------
  { pack: 'infra', check(inv) {
    const text = [inv.cmd, ...inv.args].join(' ').toLowerCase();
    const hit = (re, what, safer) => (re.test(text) ? { severity: /** @type {const} */ ('ask'), rule: 'infra-destroy', what, safer } : null);
    return hit(/^(terraform|tofu|terragrunt)\s+(destroy\b|apply\b.*-destroy)/, 'This destroys the cloud resources this configuration manages.', 'Run terraform plan -destroy first to see what would go.')
      || hit(/^kubectl\s+delete\s+.*(--all\b|\bns\b|\bnamespaces?\b|-a\b|--all-namespaces)/, 'This deletes Kubernetes resources in bulk.', 'Delete the specific resource instead.')
      || hit(/^helm\s+(uninstall|delete)\b/, 'This uninstalls a Helm release and its resources.', 'Check the release name and cluster first.')
      || hit(/^aws\s+s3\s+(rm\s+.*--recursive|rb\s+.*--force)|^aws\s+\S+\s+delete-/, 'This deletes AWS resources or files in bulk.', 'Run it with --dryrun first where possible.')
      || hit(/^gcloud\s+.*\bdelete\b|^gsutil\s+(-m\s+)?rm\s+.*-r/, 'This deletes Google Cloud resources.', 'Check the project and resource name first.')
      || hit(/^az\s+(group|resource|storage)\s+.*\bdelete\b/, 'This deletes Azure resources.', 'Check the resource group first.')
      || hit(/^docker\s+(system\s+prune\b.*(-a|--all|--volumes)|volume\s+(rm|prune)\b|rm\s+.*-f.*\$\()/, 'This deletes Docker data, possibly including database volumes.', 'Remove the specific container or volume instead.')
      || hit(/^(heroku\s+apps:destroy|vercel\s+(remove|rm)\b|fly(ctl)?\s+(apps\s+)?destroy|netlify\s+sites:delete|firebase\s+projects:delete)/, 'This deletes a deployed app or site.', 'Check the app name first.');
  } },

  // ---------- publishing ----------
  { pack: 'publish', check(inv) {
    const text = [inv.cmd, ...inv.args].join(' ').toLowerCase();
    if (/^(npm|yarn|pnpm|bun)\s+publish\b|^cargo\s+publish\b|^twine\s+upload\b|^gem\s+push\b|^poetry\s+publish\b|^dotnet\s+nuget\s+push\b/.test(text)) return { severity: 'ask', rule: 'publish-package', what: 'This publishes a package publicly, and published versions usually cannot be taken back.', safer: 'Check the version and contents first (for example npm pack --dry-run).' };
    if (/^(vercel\s+.*--prod|netlify\s+deploy\s+.*--prod|firebase\s+deploy\b|fly(ctl)?\s+deploy\b|railway\s+up\b|gh\s+release\s+create\b)/.test(text)) return { severity: 'ask', rule: 'deploy', what: 'This deploys to production, where real users will see it.', safer: 'Deploy to a preview first if you can.' };
    return null;
  } },
];

export const PACKS_BY_MODE = {
  beginner: ['core.filesystem', 'core.git', 'core.secrets', 'database', 'infra', 'publish'],
  standard: ['core.filesystem', 'core.git', 'core.secrets', 'database'],
  off: [],
};

/** @param {string} p */
function isSecretPath(p) { return isSensitivePath(String(p).replace(/^["']|["']$/g, '')); }
