// Shell command parsing for the guard. Splits chains, unwraps wrappers
// (bash -c, powershell -Command, cmd /c, eval, $(...)), strips prefixes such
// as sudo and env, and normalises flags, so that "sudo bash -c 'rm -fr ~'"
// is seen as rm with recursive and force flags on ~.
//
// The approach follows cc-safety-net (https://github.com/kenryu42/claude-code-safety-net,
// MIT, Copyright (c) 2026 J Liew); this is an independent implementation.

const MAX_DEPTH = 5;

/**
 * @typedef {object} Invocation
 * @property {string} cmd          Command name, lower case, without path or .exe.
 * @property {string[]} args       Arguments after the command, unquoted.
 * @property {Set<string>} flags   Normalised flags: single letters for short flags, words for long ones.
 * @property {string[]} positional Arguments that are not flags.
 * @property {string} raw          The segment's original text.
 * @property {string[]} redirects  Files written by > or >> in this segment.
 */

/**
 * Every simple command a shell string would run, including wrapped ones.
 * @param {string} command
 * @returns {Invocation[]}
 */
export function invocations(command) {
  const out = [];
  walk(String(command || ''), 0, out);
  return out;
}

/** @param {string} text @param {number} depth @param {Invocation[]} out */
function walk(text, depth, out) {
  if (depth > MAX_DEPTH) return;
  for (const inner of substitutions(text)) walk(inner, depth + 1, out);
  for (const seg of splitChain(text)) {
    const { words, redirects } = tokenize(seg);
    const stripped = stripPrefixes(words);
    if (!stripped.length) continue;
    const name = baseName(stripped[0]);
    const rest = stripped.slice(1);

    const wrapped = unwrap(name, rest);
    if (wrapped != null) {
      walk(wrapped, depth + 1, out);
      continue;
    }
    if (name === 'xargs') {
      // xargs runs the command that follows its own options.
      const i = rest.findIndex((w) => !w.startsWith('-'));
      if (i >= 0) walk(rest.slice(i).map(quoteIfNeeded).join(' '), depth + 1, out);
      continue;
    }
    if (name === 'find') {
      // find -exec <cmd> ... \; runs another command.
      const i = rest.findIndex((w) => w === '-exec' || w === '-execdir' || w === '-ok');
      if (i >= 0) walk(rest.slice(i + 1).filter((w) => w !== ';' && w !== '\\;' && w !== '+' && w !== '{}').map(quoteIfNeeded).join(' '), depth + 1, out);
    }
    out.push(describe(name, rest, seg, redirects));
  }
}

/** The script inside a wrapper command, or null when the command is not a wrapper. */
function unwrap(name, rest) {
  const lower = rest.map((w) => w.toLowerCase());
  if (['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'].includes(name)) {
    const i = lower.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w));
    return i >= 0 && rest[i + 1] != null ? rest[i + 1] : null;
  }
  if (['powershell', 'pwsh'].includes(name)) {
    const i = lower.findIndex((w) => w === '-command' || w === '-c' || w === '/c');
    if (i >= 0) return rest.slice(i + 1).join(' ');
    const enc = lower.findIndex((w) => w === '-encodedcommand' || w === '-enc' || w === '-e');
    if (enc >= 0 && rest[enc + 1]) {
      try { return Buffer.from(rest[enc + 1], 'base64').toString('utf16le'); } catch { return null; }
    }
    return null;
  }
  if (name === 'cmd') {
    const i = lower.findIndex((w) => w === '/c' || w === '/k');
    return i >= 0 ? rest.slice(i + 1).join(' ') : null;
  }
  if (name === 'eval' || name === 'invoke-expression' || name === 'iex') return rest.join(' ');
  return null;
}

/** Text inside $(...), backticks (POSIX) and PowerShell & { ... } blocks. @param {string} text */
function substitutions(text) {
  const out = [];
  let m;
  const dollar = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
  while ((m = dollar.exec(text))) out.push(m[1]);
  const tick = /`([^`]+)`/g;
  // Backticks are PowerShell escapes when followed by a single character; only treat longer spans as commands.
  while ((m = tick.exec(text))) if (m[1].length > 2) out.push(m[1]);
  return out;
}

/** Splits on ; && || | & and newlines outside quotes. @param {string} text */
export function splitChain(text) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && text[i - 1] !== '>' && text[i + 1] !== '>')) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Splits a simple command into words, removing quotes, and collects redirect targets. @param {string} seg */
export function tokenize(seg) {
  const words = [];
  const redirects = [];
  let cur = '';
  let has = false;
  let quote = null;
  let pendingRedirect = false;
  const push = () => {
    if (!has) return;
    if (pendingRedirect) { redirects.push(cur); pendingRedirect = false; } else words.push(cur);
    cur = '';
    has = false;
  };
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && (seg[i + 1] === '"' || seg[i + 1] === '\\')) { cur += seg[++i]; }
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === '>' ) {
      // 2>&1 and >&2 are not file writes.
      if (seg[i + 1] === '&') { cur = ''; has = false; i++; while (i + 1 < seg.length && /\d/.test(seg[i + 1])) i++; continue; }
      if (/^\d$/.test(cur)) { cur = ''; has = false; }
      push();
      if (seg[i + 1] === '>') i++;
      pendingRedirect = true;
      continue;
    }
    if (ch === '<') { push(); continue; }
    cur += ch;
    has = true;
  }
  push();
  return { words, redirects: redirects.filter((r) => !/^(\/dev\/null|nul|\$null)$/i.test(r)) };
}

const PREFIXES = new Set(['sudo', 'doas', 'env', 'time', 'nohup', 'nice', 'ionice', 'command', 'builtin', 'exec', 'stdbuf', 'timeout', 'caffeinate']);

/** Removes sudo, env, time and VAR=value prefixes. @param {string[]} words */
function stripPrefixes(words) {
  let w = [...words];
  for (let guard = 0; guard < 10 && w.length; guard++) {
    const name = baseName(w[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { w = w.slice(1); continue; }
    // A prefix with nothing after it is the command itself (a bare "env" prints the environment).
    if (!PREFIXES.has(name) || w.length === 1) break;
    w = w.slice(1);
    // Options of the prefix itself (sudo -u root, timeout 10, nice -n 5).
    while (w.length && (w[0].startsWith('-') || /^\d+[smhd]?$/.test(w[0]))) {
      const opt = w.shift();
      if (name === 'sudo' && /^-(u|g|h|p|C|D|r|t|U)$/.test(opt || '')) w.shift();
      if (name === 'nice' && opt === '-n') w.shift();
    }
  }
  return w;
}

/** @param {string} name @param {string[]} rest @param {string} raw @param {string[]} redirects */
function describe(name, rest, raw, redirects) {
  const flags = new Set();
  const positional = [];
  let endOfFlags = false;
  for (const a of rest) {
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && /^--[A-Za-z]/.test(a)) { flags.add(a.slice(2).split('=')[0].toLowerCase()); continue; }
    if (!endOfFlags && /^-[A-Za-z]/.test(a)) {
      const body = a.slice(1).split(':')[0];
      const word = psParameter(body);
      if (word) flags.add(word);
      else for (const c of body) flags.add(c);
      continue;
    }
    if (!endOfFlags && /^\/[A-Za-z]$/.test(a) && ['del', 'erase', 'rd', 'rmdir', 'format'].includes(name)) { flags.add(a[1].toLowerCase()); continue; }
    positional.push(a);
  }
  return { cmd: name, args: rest, flags, positional, raw, redirects };
}

const PS_PARAMETERS = ['recurse', 'force', 'path', 'literalpath', 'include', 'exclude', 'filter', 'confirm', 'whatif', 'command', 'erroraction', 'name', 'value', 'destination', 'encoding', 'number', 'disknumber', 'driveletter', 'filesystem', 'removedata', 'full'];

/**
 * A PowerShell parameter name for a dash word, allowing unambiguous prefixes
 * of three or more letters (-Rec for -Recurse), else null for POSIX flag
 * clusters such as -rfv.
 * @param {string} body
 */
function psParameter(body) {
  const lower = body.toLowerCase();
  if (PS_PARAMETERS.includes(lower)) return lower;
  if (lower.length >= 3) {
    const hits = PS_PARAMETERS.filter((p) => p.startsWith(lower));
    if (hits.length === 1) return hits[0];
  }
  return null;
}

/** "C:\\Windows\\System32\\cmd.exe" -> "cmd". @param {string} word */
export function baseName(word) {
  const last = String(word || '').split(/[\\/]/).pop() || '';
  return last.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/** @param {string} w */
function quoteIfNeeded(w) {
  return /\s/.test(w) ? `"${w}"` : w;
}
