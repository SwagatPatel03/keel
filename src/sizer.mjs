// Task sizer (G1) and cheap clarity check (G7): local rules over the prompt
// text, with no model call. Only the results (size, signal names, sign names
// and hashes of the paths the prompt names) are ever stored, never the prompt.

import crypto from 'node:crypto';
import { installKey } from './store.mjs';

/** @typedef {'trivial'|'small'|'feature'|'risky'} Size */

const RISKY_WORDS = /\b(delet\w*\s+(all|every|the\s+\w+\s+(table|database|bucket|branch))|drop\s+(the\s+)?(\w+\s+)?(table|database|column|collection)|wipe|truncate|migrat\w*|schema change|production|prod\b|deploy\w*|release|secrets?|credentials?|api keys?|passwords?|payments?|billing|stripe|paypal|subscriptions?|force[- ]?push|rewrite (the )?history|rm -rf|encrypt\w*|personal data|gdpr|oauth|sso|(login|log in|sign[- ]?in|sign[- ]?up) with|auth(entication|orization)\b|permissions? system|roles? and permissions)\b/i;
const RISKY_PATHS = /(^|[\s`'"(/])(migrations?\/|\.env\b|\.github\/workflows|dockerfile|docker-compose|terraform|\.tf\b|k8s|helm|schema\.prisma|supabase\/)/i;

const FEATURE_VERB = String.raw`(add|build|create|implement|integrate|introduce|support|set ?up|design|redesign|make|allow|enable|let users?)`;
const FEATURE_OBJECT = String.raw`(page|screen|view|feature|endpoint|api|route|component|dashboard|form|flow|wizard|system|module|service|integration|upload|download|search|filter|sort(ing)?|pagination|notifications?|emails?|chat|comments?|cart|checkout|chart|graph|export|import|report|settings?|profiles?|dark mode|mode|bar|sidebar|menu|modal|onboarding|cli|command|webhook|cache|caching|queue|job|scheduler|tests? suite)`;
const FEATURE_PHRASE = new RegExp(String.raw`\b${FEATURE_VERB}\b(\W+\w+){0,4}?\W+${FEATURE_OBJECT}\b`, 'i');
const BIG_VERB = /\b(refactor|restructure|rewrite|re-?architect|port|convert)\b/i;

const TRIVIAL_WORDS = /\b(typos?|rename|colou?rs?|wording|headline|title|label|placeholder|padding|margin|font|spacing|bump|comments?|readme|log message|indent\w*|whitespace|capitali[sz]\w*|spelling|copy text|tooltip|icon|copyright|year|unused imports?|dead code|console\.log)\b/i;

export const FIX_WORDS = /\b(fix\w*|broken|bug\w*|doesn'?t work|does not work|not working|crash\w*|errors?|fails?|failing|issue|wrong)\b/i;
// A symptom is anything that says what goes wrong; "crashes" or "500" is one, "the bug" is not.
export const SYMPTOM = /\b(when|after|shows?|showing|returns?|throws?|instead|expected|says|errors?|exception|crash\w*|fail\w*|undefined|null|nan|404|500|blank|empty|freez\w*|slow|hangs?|missing|duplicat\w*|twice|never|always|only|wrong)\b|["'`]/i;
const APP_PART = /\b(page|screen|button|form|endpoint|function|method|class|component|route|file|table|modal|navbar|nav|header|footer|sidebar|api|readme|test|module|database|query|style|css|script|config|login|signup|checkout|cart|homepage|landing|dashboard|menu|model|schema|hook|server|client|app)\b/i;
const IDENTIFIER = /\b([a-z]+[A-Z]\w*|[a-z]+_[a-z_]+|\w+\(\))/;
const PATH_TOKEN = /(?:^|[\s(`'"])((?:[\w.-]+\/)*[\w-][\w.-]*\.[A-Za-z][A-Za-z0-9]{0,6}|(?:[\w.-]+\/)*\.[A-Za-z][\w.-]*[\w-]|(?:[\w.-]+\/)+[\w.-]*)(?=$|[\s)`'",;:!?]|\.(?:\s|$))/g;

/**
 * @param {string} prompt
 * @returns {{size: Size, signals: string[], override: 'quick'|'plan'|null, scope: string[]}}
 */
export function sizeTask(prompt) {
  const raw = String(prompt || '');
  const override = /^\s*quick:/i.test(raw) ? 'quick' : /^\s*plan:/i.test(raw) ? 'plan' : null;
  const text = raw.replace(/^\s*(quick|plan):\s*/i, '');
  const scope = scopeHashes(text);
  if (override === 'quick') return { size: 'small', signals: ['override quick:'], override, scope };
  if (override === 'plan') return { size: 'feature', signals: ['override plan:'], override, scope };

  const signals = [];
  const risky = RISKY_WORDS.exec(text);
  if (risky) signals.push(`risky: ${risky[0].toLowerCase()}`);
  const riskyPath = RISKY_PATHS.exec(text);
  if (riskyPath) signals.push(`risky path: ${riskyPath[2].toLowerCase()}`);
  if (risky || riskyPath) return { size: 'risky', signals, override, scope };

  const feature = FEATURE_PHRASE.exec(text);
  if (feature) signals.push(`feature: ${feature[0].toLowerCase().replace(/\s+/g, ' ')}`);
  const big = BIG_VERB.exec(text);
  if (big) signals.push(`feature: ${big[0].toLowerCase()}`);
  const paths = namedPaths(text);
  if (paths.length >= 3) signals.push(`feature: ${paths.length} files named`);
  const words = wordCount(text);
  const trivial = TRIVIAL_WORDS.exec(text);
  if (trivial && words <= 20 && !big) {
    return { size: 'trivial', signals: [`trivial: ${trivial[0].toLowerCase()}`], override, scope };
  }
  if (signals.length) return { size: 'feature', signals, override, scope };
  return { size: 'small', signals: FIX_WORDS.test(text) ? ['small: fix'] : [], override, scope };
}

/**
 * Vague signs in a prompt. Questions are asked only when there are two or more.
 * Missing "done" criteria is not a sign here: feature prompts go through plan
 * mode and the plan check, which ask about it.
 * @param {string} prompt
 * @param {Size} size
 * @returns {{signs: string[], questions: string[], ask: boolean}}
 */
export function clarityCheck(prompt, size) {
  const raw = String(prompt || '');
  if (/^\s*quick:/i.test(raw)) return { signs: [], questions: [], ask: false };
  const text = raw.replace(/^\s*(quick|plan):\s*/i, '');
  const words = wordCount(text);
  const signs = [];
  if (size !== 'trivial' && FIX_WORDS.test(text) && !SYMPTOM.test(text)) signs.push('no-symptom');
  if (!namedPaths(text).length && !APP_PART.test(text) && !IDENTIFIER.test(text)) signs.push('no-target');
  if (words < 5) signs.push('too-short');

  const questions = [];
  if (signs.includes('no-symptom')) questions.push('What happens now, and what did you expect to happen instead?');
  if (signs.includes('no-target')) questions.push('Which file, page or part of the app is this about?');
  if (signs.includes('too-short')) questions.push('How will you know it is done? What should be true at the end?');
  return { signs, questions: questions.slice(0, 3), ask: signs.length >= 2 };
}

/** File and folder paths a text names. @param {string} text */
export function namedPaths(text) {
  const out = new Set();
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(String(text)))) {
    const p = m[1].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (/^(e\.g|i\.e|etc|vs|v?\d+(\.\d+)+)$/i.test(p) || /^https?:/i.test(p) || p.length < 3) continue;
    out.add(p);
  }
  return [...out];
}

/**
 * Keyed hashes of what a prompt names, so the plan check can tell whether a
 * plan stays in scope without storing paths. A named file contributes its path and
 * its file name; a named folder covers everything inside it.
 * @param {string} text
 */
export function scopeHashes(text) {
  const out = new Set();
  for (const p of namedPaths(text)) {
    const norm = normPath(p);
    if (isFolder(p)) {
      out.add(shortHash(`dir:${norm}`));
    } else {
      out.add(shortHash(norm));
      out.add(shortHash(norm.split('/').pop() || norm));
    }
  }
  return [...out];
}

/** The keys a file path is in scope by: its path, its file name, or any folder above it. @param {string} p */
export function pathKeys(p) {
  const norm = normPath(p);
  const parts = norm.split('/').filter(Boolean);
  const keys = [shortHash(norm), shortHash(parts[parts.length - 1])];
  for (let i = 1; i < parts.length; i++) keys.push(shortHash(`dir:${parts.slice(0, i).join('/')}`));
  return [...new Set(keys)];
}

/** @param {string} p */
function normPath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
}

/** A name with no extension in its last part, or one ending in a slash, is a folder. @param {string} p */
function isFolder(p) {
  const last = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  return /\/$/.test(p) || !/\.[A-Za-z]/.test(last);
}

/** A keyed hash (HMAC with this install's key), so stored values cannot be matched elsewhere. @param {string} s */
function shortHash(s) {
  return crypto.createHmac('sha256', installKey()).update(s).digest('hex').slice(0, 12);
}

/** @param {string} text */
function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}
