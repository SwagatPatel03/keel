// The guard: decides whether a tool call may run, should ask the user, or is
// refused. Shell commands go through the parser and rule packs; file tools
// go through the protected-path rules.

import { invocations } from './shell.mjs';
import { RULES, PACKS_BY_MODE } from './rules.mjs';
import { relativeFile } from '../policy.mjs';
import { patchFiles } from '../adapters/common.mjs';
import { checkPath } from './paths.mjs';

/**
 * @typedef {{severity: 'refuse'|'ask', rule: string, pack: string, what: string, safer: string}} Finding
 * @typedef {{decision: 'allow'|'ask'|'refuse', findings: Finding[]}} Verdict
 * @typedef {{root: string, mode?: string, packs?: string[], allow?: string[], protect?: string[], allowPaths?: string[]}} GuardConfig
 */

const SHELL = new Set(['Bash', 'PowerShell', 'shell', 'exec_command', 'run_terminal_cmd']);
const READ = new Set(['Read', 'read_file', 'NotebookRead']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file', 'apply_patch']);

/**
 * @param {string} tool  Tool name as the agent reports it.
 * @param {any} input    Tool input.
 * @param {GuardConfig} cfg
 * @returns {Verdict}
 */
export function checkToolCall(tool, input, cfg) {
  const packs = new Set(cfg.packs || PACKS_BY_MODE[cfg.mode || 'beginner'] || PACKS_BY_MODE.beginner);
  if (!packs.size) return { decision: 'allow', findings: [] };
  /** @type {Finding[]} */
  const findings = [];
  const pathCtx = { root: cfg.root, protect: cfg.protect || [], allow: cfg.allowPaths || [] };

  if (SHELL.has(tool) && typeof input?.command === 'string') {
    if ((cfg.allow || []).some((re) => safeRegExp(re)?.test(input.command))) return { decision: 'allow', findings: [] };
    // Patterns that only make sense on the whole command, before it is split.
    if (packs.has('core.filesystem') && /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(input.command)) {
      findings.push({ severity: 'refuse', rule: 'fork-bomb', pack: 'core.filesystem', what: 'This is a fork bomb: it starts copies of itself until the computer freezes.', safer: '' });
    }
    for (const inv of invocations(input.command)) {
      for (const rule of RULES) {
        if (!packs.has(rule.pack)) continue;
        const f = rule.check(inv, { root: cfg.root });
        if (f) findings.push({ ...f, pack: rule.pack });
      }
      // Shell writes into protected files (>, >>, tee, sed -i, cp/mv destination).
      for (const target of writeTargets(inv)) {
        const p = checkPath(target, 'edit', pathCtx);
        if (p && p.rule !== 'secret-file') findings.push({ ...p, pack: 'core.paths' });
        else if (p) findings.push({ ...p, pack: 'core.paths', what: p.what.replace('Claude wants to change', 'This command writes to') });
      }
    }
  } else if (packs.has('core.secrets') || packs.has('core.filesystem')) {
    const patch = typeof input === 'string' ? input : input?.patch || input?.input || input?.patchText || (tool === 'apply_patch' ? input?.command : '') || '';
    let patchPaths;
    try { patchPaths = patchFiles(patch); }
    catch { return { decision: 'refuse', findings: [{ severity: 'refuse', rule: 'ambiguous-patch', pack: 'core.paths', what: 'Keel cannot safely identify every patch path.', safer: 'Use explicit project-relative file paths.' }] }; }
    const files = new Set([input?.file_path || input?.notebook_path || input?.path || input?.target_file, ...(Array.isArray(input?.files) ? input.files.filter((f) => typeof f === 'string') : []), ...(Array.isArray(input?.edits) ? input.edits : []).map((e) => e.file_path || e.path), ...patchPaths].filter(Boolean));
    for (const file of files) if (READ.has(tool) || EDIT.has(tool)) {
      if (tool === 'apply_patch') { try { relativeFile(cfg.root, file); } catch { findings.push({ severity: 'refuse', rule: 'path-escape', pack: 'core.paths', what: 'Patch path escapes the project or follows an external link.', safer: 'Use a project-relative path.' }); } }
      const p = checkPath(file, READ.has(tool) ? 'read' : 'edit', pathCtx);
      if (p) findings.push({ ...p, pack: 'core.paths' });
    }
  }

  const decision = findings.some((f) => f.severity === 'refuse') ? 'refuse' : findings.length ? 'ask' : 'allow';
  return { decision, findings: dedupe(findings) };
}

/** Files a command writes to. @param {import('./shell.mjs').Invocation} inv */
function writeTargets(inv) {
  const out = [...inv.redirects];
  if (inv.cmd === 'tee' || inv.cmd === 'tee-object' || inv.cmd === 'set-content' || inv.cmd === 'add-content' || inv.cmd === 'out-file') out.push(...inv.positional.slice(inv.cmd === 'tee' ? 0 : 0, 1));
  if (inv.cmd === 'sed' && (inv.flags.has('i') || inv.flags.has('in-place'))) out.push(...inv.positional.slice(1));
  if (['cp', 'mv', 'copy', 'move', 'copy-item', 'move-item'].includes(inv.cmd) && inv.positional.length >= 2) out.push(inv.positional[inv.positional.length - 1]);
  return out;
}

/** @param {Finding[]} list */
function dedupe(list) {
  const seen = new Set();
  return list.filter((f) => {
    const key = `${f.rule}|${f.what}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {string} s */
function safeRegExp(s) {
  try { return new RegExp(s); } catch { return null; }
}

/**
 * The message shown when Keel asks the user (Claude Code's permission prompt).
 * @param {Finding[]} findings
 * @param {boolean} checkpointSaved
 */
export function askMessage(findings, checkpointSaved) {
  const main = findings[0];
  const extra = findings.slice(1).map((f) => f.what).join(' ');
  const safer = [...new Set(findings.map((f) => f.safer).filter(Boolean))].join(' ');
  const undo = checkpointSaved ? ' Keel saved a checkpoint first, so /keel:revert can bring back project files.' : '';
  return `Keel: ${main.what}${extra ? ` ${extra}` : ''}${safer ? ` ${safer}` : ''}${undo}`.replace(/\s+/g, ' ').trim();
}

/**
 * The message the agent gets when Keel refuses, or when the agent cannot ask
 * the user itself (Codex).
 * @param {Finding[]} findings
 * @param {'refuse'|'ask'} decision
 */
export function refusalMessage(findings, decision) {
  const what = findings.map((f) => f.what).join(' ');
  const safer = [...new Set(findings.map((f) => f.safer).filter(Boolean))].join(' ');
  const next = decision === 'refuse'
    ? 'Do not try another way to do the same thing. If the user really wants this, ask them to run it themselves.'
    : 'Do not run it now. Explain this to the user in one or two sentences and ask whether they want to run it themselves.';
  return `Keel ${decision === 'refuse' ? 'refused' : 'paused'} this command: ${what}${safer ? ` ${safer}` : ''} ${next}`.replace(/\s+/g, ' ').trim();
}
