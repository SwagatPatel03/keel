// Helpers shared by the adapters for Cursor, Copilot CLI, Antigravity and
// OpenCode. Each agent names its tools differently; adapters map them onto
// the names Keel's guard and records already use: "Bash" with {command} for
// shell commands, "Read" with {file_path} for reads, and "Edit" with
// {file_path} for writes and edits.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { excerpt } from '../redact.mjs';
import { classifyCommand, normaliseError, normaliseCommand } from '../checks.mjs';
import { errorLine } from './claude-code.mjs';

/** @typedef {'Bash'|'Read'|'Edit'|null} ToolKind */

/**
 * Keel's name for an agent's tool, from lists of the agent's own names.
 * @param {string} name
 * @param {{shell: string[], read: string[], edit: string[]}} names  Lower-case tool names.
 * @returns {ToolKind}
 */
export function toolKind(name, names) {
  const n = String(name || '').toLowerCase();
  if (names.shell.includes(n)) return 'Bash';
  if (names.read.includes(n)) return 'Read';
  if (names.edit.includes(n)) return 'Edit';
  return null;
}

/**
 * Tool input in Keel's shape: {command} for shell, {file_path} for files.
 * @param {ToolKind} kind @param {any} input
 */
export function canonicalInput(kind, input) {
  const i = typeof input === 'string' ? parseJson(input) ?? { command: input } : (input || {});
  if (kind === 'Bash') return { command: firstString(i.command, i.CommandLine, i.cmd, i.script) };
  if (kind === 'Read' || kind === 'Edit') return { file_path: firstString(i.file_path, i.filePath, i.path, i.target_file, i.TargetFile, i.AbsolutePath, i.file) };
  return i;
}

/** A tool_result record with nothing filled in. @param {string} tool @param {string|null} id */
export function emptyResult(tool, id) {
  return {
    tool, toolUseId: id || null, ok: true, exitCode: null, command: null, isTest: false, isBuild: false,
    files: [], fileHash: null, originalHash: null, errorExcerpt: null, errorFingerprint: null, commandKey: null,
  };
}

/**
 * Fills in a shell command's result.
 * @param {ReturnType<typeof emptyResult>} r
 * @param {string} command
 * @param {{ok: boolean, exitCode: number|null, errorText?: string|null}} outcome
 */
export function shellResult(r, command, outcome) {
  r.command = excerpt(command, 200);
  r.commandKey = hash(normaliseCommand(command));
  Object.assign(r, classifyCommand(command));
  r.exitCode = outcome.exitCode;
  r.ok = outcome.ok;
  if (!r.ok) failure(r, 'Bash', outcome.errorText || '');
  return r;
}

/**
 * Fills in a file edit's result. Files outside the project are not recorded.
 * @param {ReturnType<typeof emptyResult>} r @param {string} root @param {string|null} file
 */
export function editResult(r, root, file) {
  if (!file) return r;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (rel.startsWith('../') || path.isAbsolute(rel)) return r;
  r.files = [rel];
  r.fileHash = hashFile(abs);
  return r;
}

/** Marks a result as failed with a short, masked error. @param {ReturnType<typeof emptyResult>} r @param {string} tool @param {string} text */
export function failure(r, tool, text) {
  r.ok = false;
  r.errorExcerpt = excerpt(errorLine(text), 200);
  r.errorFingerprint = hash(`${tool}\n${normaliseError(text)}`);
  return r;
}

/**
 * An exit code written into a tool's text output, as several agents do
 * ("<shellId: 0 completed with exit code 1>" in Copilot CLI 1.0.98,
 * "Exit code: 1", "exit status 1"). The last one in the text wins.
 * @param {string|null|undefined} text
 */
export function exitCodeIn(text) {
  const all = [...String(text || '').matchAll(/(?:completed|exited) with (?:exit )?code (\d+)|\bexit (?:code|status)[:\s]+(\d+)/gi)];
  const m = all[all.length - 1];
  return m ? Number(m[1] ?? m[2]) : null;
}

/** Files named in an apply_patch body ("*** Update File: <path>"). @param {string} patch */
export function patchFiles(patch) {
  const out = [];
  for (const m of String(patch).matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] || m[2]).trim());
  return [...new Set(out)];
}

/**
 * The latest message from one role in a JSON Lines transcript whose format is
 * not documented. It accepts the common shapes: {role, content}, {message:
 * {role, content}}, {type: "user"|"assistant", ...} and {type: "*.message",
 * data: {content}}, with content as text or a list of text parts.
 * @param {string|null|undefined} file
 * @param {'user'|'assistant'} role
 * @returns {string|null}
 */
export function lastTranscriptText(file, role) {
  let text;
  try { text = fs.readFileSync(String(file), 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message && typeof e.message === 'object' ? e.message : e;
    const r = String(m.role || e.role || e.type || e.source || '').toLowerCase();
    const isRole = role === 'user' ? /^(user|human)\b|user[._]?message|user_input/.test(r) : /^(assistant|model|agent)\b|assistant[._]?message|model[._]?response/.test(r);
    if (!isRole) continue;
    const content = textOf(m.content ?? e.data?.content ?? e.content ?? e.text ?? m.parts ?? e.data?.text);
    if (content) return content;
  }
  return null;
}

/** @param {any} c */
function textOf(c) {
  if (typeof c === 'string') return c.trim() || null;
  if (Array.isArray(c)) {
    const t = c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' || p?.text ? p.text : '')).filter(Boolean).join('\n').trim();
    return t || null;
  }
  return null;
}

/** @param {...any} values */
function firstString(...values) {
  for (const v of values) if (typeof v === 'string' && v) return v;
  return undefined;
}

/** @param {string} s */
export function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** @param {string} s */
export function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
}

/** @param {string} abs */
function hashFile(abs) {
  try { return hash(fs.readFileSync(abs, 'utf8')); } catch { return hash('<missing>'); }
}

/** "[Keel] " in front of a follow-up the agent receives as a new prompt, so Keel treats it as a continuation. @param {string} text */
export function asFollowUp(text) {
  return /^\[Keel\]/.test(text) ? text : `[Keel] ${text}`;
}
