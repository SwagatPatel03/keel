// Plan check (G2): reads a plan with fixed rules, finds the gaps a senior
// developer would ask about, and turns them into at most three questions plus
// a short plain-English checklist. No model call. Plan text is never stored.

import { namedPaths, pathKeys } from './sizer.mjs';
import { isTestFile } from './testdiff.mjs';

/**
 * @typedef {'no-test'|'no-error-handling'|'out-of-scope'|'assumption'|'no-rollback'|'too-big'} GapKind
 * @typedef {{kind: GapKind, finding: string, question: string}} Gap
 */

const TEST_STEP = /\b(tests?|testing|unit test|spec|verify|verification|assert\w*|check that|run (the )?(test|suite|app|build)|manual(ly)? check|smoke test|try it)\b/i;
// Words that mean the change handles outside data, which can fail or be bad.
// Plain "input" or "file" is too broad (a search input, "in this file").
const TOUCHES_INPUT = /\b(api|fetch|request|http|endpoint|uploads?|(read|write|save|load)s? (a |the )?files?|file (upload|system)|user input|form (submission|data)|forms?|pars(e|ing)|network|payments?|database|db|query|json|csv|user data|third[- ]party|webhook)\b/i;
const HANDLES_ERRORS = /\b(errors?|fail\w*|invalid|edge cases?|validat\w*|timeouts?|retr(y|ies)|empty|missing|exceptions?|catch|fallback|too (large|big|long)|limits?|reject\w*|404|500|status code|offline|not found)\b/i;
const ROLLBACK = /\b(roll ?back|undo|backups?|revert|restore|reversible|down migration|feature flag|dry run)\b/i;
const GUESS = /[^.\n]*\b(assum\w*|probably|presumably|i think|i believe|should be fine|i guess|likely|hopefully|might already)\b[^.\n]*/i;
const SENSITIVE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.env[^/]*|dockerfile|docker-compose[^/]*|\.github\/workflows\/[^/]+|migrations?\/[^/]+|schema\.prisma)$/i;
const NON_TASK_HEADING = /^(goal|context|overview|summary|background|files?|review focus|risks?|notes?|testing|verification|architecture|tech stack|open questions|assumptions|out of scope)\b/i;

/**
 * @param {string} plan  The plan text.
 * @param {{scope?: string[], size?: string, exists?: (path: string) => boolean}} [opts]
 *   Scope hashes from the prompt, the task size, and a check for whether a project file exists.
 */
export function checkPlan(plan, opts = {}) {
  const text = stripCode(String(plan || ''));
  /** @type {Gap[]} */
  const gaps = [];
  const { phases, tasks } = measure(text);

  if (!TEST_STEP.test(text)) {
    gaps.push({
      kind: 'no-test',
      finding: 'No step says how the change will be tested.',
      question: 'How should we check that this works: a new automated test, the existing tests, or a manual check you will do?',
    });
  }

  // File names such as payment.js say where a change goes, not what it handles.
  const prose = namedPaths(text).reduce((t, p) => t.split(p).join(' '), text);
  const input = TOUCHES_INPUT.exec(prose);
  if (input && !HANDLES_ERRORS.test(prose)) {
    const topic = input[0].toLowerCase();
    gaps.push({
      kind: 'no-error-handling',
      finding: `The plan works with ${article(topic)} but says nothing about what happens when it fails or gets bad input.`,
      question: `What should happen when the ${topic} part fails, for example bad input or a service that is down?`,
    });
  }

  const outside = outOfScope(text, opts.scope || [], opts.exists || (() => true));
  if (outside.length) {
    const list = outside.slice(0, 3).map((p) => `\`${p}\``).join(', ');
    gaps.push({
      kind: 'out-of-scope',
      finding: `The plan also changes ${list}, which the request did not mention.`,
      question: `The plan also changes ${list}. Is that OK, or should it stay out of this change?`,
    });
  }

  const guess = GUESS.exec(text);
  if (guess) {
    const quote = guess[0].replace(/^[\s>*#\-\d.)]+/, '').trim().slice(0, 120);
    gaps.push({
      kind: 'assumption',
      finding: `The plan rests on a guess: "${quote}".`,
      question: `The plan assumes: "${quote}". Is that right?`,
    });
  }

  if (opts.size === 'risky' && !ROLLBACK.test(text)) {
    gaps.push({
      kind: 'no-rollback',
      finding: 'This is a risky change, and the plan does not say how to undo it.',
      question: 'If this goes wrong, how should we undo it?',
    });
  }

  if (phases > 3 || tasks > 9) {
    // Name only the part that is over the limit, so the finding and the question agree.
    const size = [phases > 3 ? `${phases} phases` : '', tasks > 9 ? `${tasks} tasks` : ''].filter(Boolean).join(' and ');
    gaps.push({
      kind: 'too-big',
      finding: `The plan has ${size}, more than Keel's limit of 3 phases of 3 tasks.`,
      question: `This plan has ${size}. Should we do only the first part now and plan the rest after?`,
    });
  }

  return {
    gaps,
    questions: gaps.slice(0, 3).map((g) => g.question),
    checklist: checklist(text),
    phases,
    tasks,
  };
}

/**
 * Existing files the plan names that fall outside what the request named.
 * New files are part of building the feature, so only sensitive ones count.
 */
function outOfScope(text, scope, exists) {
  const inScope = new Set(scope);
  const out = [];
  for (const p of namedPaths(text)) {
    if (!/\.[A-Za-z]/.test(p.split('/').pop() || '')) continue; // folders alone are not changes
    if (isTestFile(p)) continue; // adding tests is always in scope
    if (!SENSITIVE.test(p) && !exists(p)) continue;
    const keys = pathKeys(p);
    const covered = inScope.size > 0 && keys.some((k) => inScope.has(k));
    if (inScope.size > 0 ? !covered : SENSITIVE.test(p)) out.push(p);
  }
  return out;
}

/** Counts phases (section headings) and tasks (checkboxes, numbered steps or "Task" headings). */
function measure(text) {
  const lines = text.split(/\r?\n/);
  let phases = 0;
  let taskHeadings = 0;
  let checkboxes = 0;
  let numbered = 0;
  let titleSeen = false;
  for (const line of lines) {
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      if (h[1].length === 1 && !titleSeen) { titleSeen = true; continue; }
      const title = h[2].replace(/[*_`]/g, '').trim();
      if (/^(task|step)\b/i.test(title)) taskHeadings++;
      else if (!NON_TASK_HEADING.test(title)) phases++;
      continue;
    }
    if (/^\s*[-*]\s+\[[ xX]\]/.test(line)) checkboxes++;
    else if (/^\d+[.)]\s+\S/.test(line)) numbered++;
  }
  const tasks = Math.max(taskHeadings, checkboxes, numbered);
  return { phases: Math.max(phases, taskHeadings ? 1 : 0), tasks };
}

/** Up to ten short lines, one per step, in plain words. */
function checklist(text) {
  const items = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s{0,3}(?:[-*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{2,4}\s+)(.+)$/.exec(line);
    if (!m) continue;
    const clean = m[1].replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
    if (!clean || NON_TASK_HEADING.test(clean) || /^(files?|create|modify|test):?$/i.test(clean)) continue;
    items.push(clean.length > 100 ? clean.slice(0, 99) + '…' : clean);
    if (items.length === 10) break;
  }
  return items;
}

/** @param {string} text */
function stripCode(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** @param {string} noun */
function article(noun) {
  return /^(api|http|json|csv|db)$/.test(noun) ? `the ${noun.toUpperCase()}` : /s$/.test(noun) ? noun : `${/^[aeiou]/.test(noun) ? 'an' : 'a'} ${noun}`;
}
