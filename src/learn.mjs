// Learn-while-shipping (G5): short explanations and one comprehension question,
// only on turns where the user can learn something (debugging, or something new
// added to the project). Every other turn gets nothing, and the agent's output
// style is never changed, so its normal engineering behaviour stays on.
//
// The pattern follows Anthropic's explanatory-output-style plugin (instructions
// added through a hook instead of a different output style); the wording
// follows the "code plus explanation" and conceptual-question patterns that
// kept comprehension high in Anthropic's January 2026 skill-formation study.
// Only tags and package names are ever stored, never the prompt or the answer.

import path from 'node:path';
import { FIX_WORDS, SYMPTOM } from './sizer.mjs';
import { terminalCommand } from './runtime.mjs';

// Signs of a bug that need no fix word: an error name, a crash, a stack trace.
const STRONG_SYMPTOM = /\b(nan|undefined is not|is not a function|is not defined|cannot read propert\w*|crash\w*|throws?|exceptions?|traceback|stack ?trace|segfault|segmentation fault|panic(ked)?|[A-Z]\w*(Error|Exception))\b|\b(returns?|gives?|shows?|throws?) (a )?(404|500|nan|undefined)\b|^\s*at \S+ \(.+:\d+:\d+\)/m;

/**
 * Whether a prompt is a debugging request: a fix word with a symptom, or a
 * clear sign of a bug on its own. Trivial changes and quick: prompts never are.
 * @param {string|null|undefined} prompt
 * @param {string} size  The sizer's result.
 */
export function isDebuggingPrompt(prompt, size) {
  const raw = String(prompt || '');
  if (/^\s*quick:/i.test(raw) || size === 'trivial') return false;
  const text = raw.replace(/^\s*plan:\s*/i, '');
  return STRONG_SYMPTOM.test(text) || (FIX_WORDS.test(text) && SYMPTOM.test(text));
}

/**
 * Practice questions teach most when the learner hears whether they were
 * right, so the agent answers the user's reply. Nothing is stored.
 */
export const ANSWER_FEEDBACK = 'If they answer in their next message, start your reply by telling them in one or two sentences whether they were right, and correct anything they missed.';

/** The note added to the agent's context on a debugging prompt. */
export const DEBUGGING_NOTE = `[Keel] Learning note: this looks like a debugging task. Work exactly as you normally would. When you finish, add a short section titled "What was wrong" with 2 to 3 plain sentences: the root cause, how you found it, and how to spot this kind of bug next time. Then ask the user one short open question that checks they understood the cause. Do not give the answer until they reply. ${ANSWER_FEEDBACK}`;

/**
 * The one-time message that tells the user notes are on and how to turn them off.
 * Codex has no Keel slash commands, so it gets the terminal command instead.
 * @param {string} agent
 * @param {string|null} [pluginRoot]  Keel's install folder.
 */
export function learnNotice(agent, pluginRoot) {
  const off = agent === 'codex' ? `run ${learnOffCommand(pluginRoot)} in a terminal` : 'run /keel:learn off';
  return `Keel: Keel adds a short explanation and one question on debugging turns and when something new is added to your project. If you do not want them, ${off}.`;
}

/**
 * The sentence Codex adds to its first learning note on a machine.
 * @param {string|null|undefined} pluginRoot
 */
export function learnOffSentence(pluginRoot) {
  return `Keel asked for this note. To turn these notes off, run ${learnOffCommand(pluginRoot)} in a terminal.`;
}

/** @param {string|null|undefined} pluginRoot */
function learnOffCommand(pluginRoot) {
  return `${terminalCommand(pluginRoot)} learn off`;
}

// Files that list a project's dependencies.
const MANIFESTS = /(^|\/)(package\.json|requirements[\w.-]*\.txt|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile)$/;

// Kinds of file whose first appearance in a project is a new concept.
const NEW_KINDS = [
  { kind: 'Dockerfile', test: (p) => /(^|\/)(Dockerfile[\w.-]*|[\w.-]*\.Dockerfile|(docker-)?compose\.ya?ml)$/i.test(p) },
  { kind: 'CI workflow', test: (p) => /(^|\/)\.github\/workflows\/[^/]+\.ya?ml$|(^|\/)\.gitlab-ci\.ya?ml$|(^|\/)\.circleci\/config\.ya?ml$/i.test(p) },
  { kind: 'database migration', test: (p) => /(^|\/)(migrations?|migrate)\/|(^|\/)prisma\/migrations\//i.test(p) },
];

/**
 * @typedef {{tag: 'fixed-failure', command: string|null}
 *   | {tag: 'dependency', names: string[]}
 *   | {tag: 'new-file', kind: string}} Moment
 */

/**
 * What the user could learn from a turn that did not get a note at the start.
 * New dependencies come first, then the first file of a new kind, then a
 * failing test or build that the agent fixed.
 * @param {object} input
 * @param {any[]} input.toolResults        This prompt's tool_result events, oldest first.
 * @param {{status: string, path: string}[]|null} input.changes  Files changed since the prompt started, or null if unknown.
 * @param {(file: string, side: 'before'|'after') => string|null} input.read  File content at the start or end of the prompt.
 * @param {string[]|null} input.filesBefore  Every project file at the start of the prompt, or null if unknown.
 * @returns {Moment|null}
 */
export function learningMoment({ toolResults, changes, read, filesBefore }) {
  if (changes) {
    const names = [];
    for (const c of changes) {
      if (c.status === 'D' || !MANIFESTS.test(c.path)) continue;
      const before = new Set(dependencies(c.path, read(c.path, 'before')));
      for (const name of dependencies(c.path, read(c.path, 'after'))) if (!before.has(name) && !names.includes(name)) names.push(name);
    }
    if (names.length) return { tag: 'dependency', names: names.slice(0, 5) };

    if (filesBefore) {
      for (const c of changes) {
        if (c.status !== 'A') continue;
        const kind = NEW_KINDS.find((k) => k.test(c.path));
        if (kind && !filesBefore.some((f) => kind.test(f))) return { tag: 'new-file', kind: kind.kind };
      }
    }
  }
  const fixed = fixedFailure(toolResults);
  return fixed ? { tag: 'fixed-failure', command: fixed } : null;
}

/**
 * A test or build command that failed, was followed by an edit, and then
 * passed. Returns the command, or null.
 * @param {any[]} toolResults
 */
export function fixedFailure(toolResults) {
  /** @type {Map<string, {command: string|null, edited: boolean}>} */
  const open = new Map();
  for (const r of toolResults) {
    if (r.files?.length) for (const f of open.values()) f.edited = true;
    if (!r.isTest && !r.isBuild) continue;
    const key = r.isTest ? 'test' : `build:${r.commandKey}`;
    const failed = r.ok === false || (r.exitCode != null && r.exitCode !== 0);
    if (failed) {
      if (!open.has(key)) open.set(key, { command: r.command, edited: false });
    } else if (open.get(key)?.edited) {
      return r.command || open.get(key)?.command || null;
    } else {
      open.delete(key);
    }
  }
  return null;
}

/**
 * The instruction that sends the agent back once to add a learning section.
 * @param {Moment} m
 */
export function learningRequest(m) {
  const tail = `Then ask the user one short open question that checks they understood it. Do not give the answer until they reply. ${ANSWER_FEEDBACK} Do not repeat your previous answer, and do not change any files.`;
  if (m.tag === 'dependency') {
    const list = joinNames(m.names);
    return `[Keel] Before you finish: this turn added ${m.names.length === 1 ? 'a new dependency' : 'new dependencies'} (${list}). Add a short section titled "What is new" with 2 to 3 plain sentences: what ${list} ${m.names.length === 1 ? 'does' : 'do'}, why it fits here, and one thing to watch out for when using ${m.names.length === 1 ? 'it' : 'them'}. ${tail}`;
  }
  if (m.tag === 'new-file') {
    return `[Keel] Before you finish: this turn added the project's first ${m.kind}. Add a short section titled "What is new" with 2 to 3 plain sentences: what a ${m.kind} is for, how this project uses it, and one thing to watch out for. ${tail}`;
  }
  const what = m.command ? `\`${m.command}\`` : 'a test or build';
  return `[Keel] Before you finish: during this turn ${what} failed and then passed after your edits. Add a short section titled "What was wrong" with 2 to 3 plain sentences: the root cause, how you found it, and how to spot this kind of bug next time. ${tail}`;
}

/**
 * Dependency names declared in a manifest. Unknown or broken files give none.
 * @param {string} file
 * @param {string|null} text
 * @returns {string[]}
 */
export function dependencies(file, text) {
  if (!text) return [];
  const base = path.posix.basename(file);
  try {
    if (base === 'package.json') {
      const pkg = JSON.parse(text);
      return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] || {}));
    }
    if (/^requirements/.test(base)) {
      return text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter((l) => l && !l.startsWith('-'))
        .map((l) => pyName(l)).filter(Boolean);
    }
    if (base === 'pyproject.toml') return pyproject(text);
    if (base === 'Cargo.toml') return tomlSectionKeys(text, (h) => /(^|\.)(dev-|build-)?dependencies$/.test(h));
    if (base === 'go.mod') {
      const out = [];
      let block = false;
      for (const line of text.split(/\r?\n/).map((l) => l.replace(/\/\/.*/, '').trim())) {
        if (/^require\s*\($/.test(line)) { block = true; continue; }
        if (block && line === ')') { block = false; continue; }
        const m = block ? /^(\S+)\s+v\S+/.exec(line) : /^require\s+(\S+)\s+v\S+/.exec(line);
        if (m) out.push(m[1]);
      }
      return out;
    }
    if (base === 'Gemfile') return [...text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  } catch { /* a half-written manifest has no readable dependencies */ }
  return [];
}

/** @param {string} text */
function pyproject(text) {
  const out = tomlSectionKeys(text, (h) => /(^|\.)(dependencies|dev-dependencies)$/.test(h) || /\.group\.[\w-]+\.dependencies$/.test(h))
    .filter((n) => n.toLowerCase() !== 'python');
  // PEP 621: dependencies = ["requests>=2", ...] and optional-dependencies tables of arrays.
  for (const m of text.matchAll(/^\s*(?:dependencies|[\w-]+)\s*=\s*\[([\s\S]*?)\]\s*$/gm)) {
    const header = sectionBefore(text, m.index || 0);
    if (!/^(project|project\.optional-dependencies|dependency-groups)$/.test(header)) continue;
    if (header === 'project' && !/^\s*dependencies\s*=/.test(m[0])) continue;
    for (const s of m[1].matchAll(/["']([^"']+)["']/g)) {
      const name = pyName(s[1]);
      if (name) out.push(name);
    }
  }
  return [...new Set(out)];
}

/** The TOML table header in force at a position. @param {string} text @param {number} index */
function sectionBefore(text, index) {
  const headers = [...text.slice(0, index).matchAll(/^\s*\[([^\]]+)\]\s*$/gm)];
  return headers.length ? headers[headers.length - 1][1].trim() : '';
}

/** Keys of the TOML tables whose header matches. @param {string} text @param {(h: string) => boolean} match */
function tomlSectionKeys(text, match) {
  const out = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { inside = match(header[1].trim()); continue; }
    if (!inside) continue;
    const key = /^\s*["']?([A-Za-z0-9_.\-]+)["']?\s*=/.exec(line);
    if (key) out.push(key[1]);
  }
  return out;
}

/** The package name in a Python requirement such as "requests[socks]>=2.0". @param {string} spec */
function pyName(spec) {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
  return m ? m[1] : null;
}

/** @param {string[]} names */
function joinNames(names) {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The receipt's words for each kind of note.
 * @param {any[]} learnEvents
 */
export function learnSummary(learnEvents) {
  const prompt = learnEvents.filter((e) => e.tag === 'debugging').length;
  const fixed = learnEvents.filter((e) => e.tag === 'fixed-failure').length;
  const deps = learnEvents.filter((e) => e.tag === 'dependency');
  const files = learnEvents.filter((e) => e.tag === 'new-file');
  const parts = [];
  if (prompt) parts.push(`${prompt} on ${prompt === 1 ? 'a debugging prompt' : 'debugging prompts'}`);
  if (fixed) parts.push(`${fixed} on ${fixed === 1 ? 'a test failure' : 'test failures'} Claude fixed`);
  if (deps.length) {
    const names = [...new Set(deps.flatMap((e) => e.names || []))];
    parts.push(`${deps.length} on ${deps.length === 1 ? 'a new dependency' : 'new dependencies'}${names.length ? ` (${joinNames(names.slice(0, 5))})` : ''}`);
  }
  if (files.length) parts.push(`${files.length} on ${files.length === 1 ? 'a new kind of file' : 'new kinds of files'} (${[...new Set(files.map((e) => e.fileKind))].join(', ')})`);
  if (!parts.length) return null;
  const n = learnEvents.length;
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Keel asked for ${n} learning ${n === 1 ? 'note' : 'notes'}: ${list}.`;
}
