// Pulls checkable claims out of the agent's final message with fixed rules.
// No model call. The rules prefer missing a claim over inventing one, because
// a wrong block costs the user more than a missed one.

/**
 * @typedef {object} Claims
 * @property {string|null} tests  The sentence claiming tests pass, if any.
 * @property {string|null} build  The sentence claiming a build or type check passes, if any.
 * @property {string|null} done   The sentence claiming the work is done or fixed, if any.
 * @property {{path: string, sentence: string}[]} files  Files the agent says it changed.
 */

const CODE_EXT = 'js|mjs|cjs|jsx|ts|tsx|mts|cts|py|pyi|rb|go|rs|java|kt|kts|scala|cs|fs|cpp|cc|cxx|c|h|hpp|m|mm|swift|php|vue|svelte|astro|css|scss|sass|less|html|htm|json|jsonc|yaml|yml|toml|ini|cfg|md|mdx|rst|txt|sql|graphql|gql|proto|sh|bash|zsh|ps1|psm1|bat|cmd|lua|dart|ex|exs|erl|hs|ml|r|jl|tf|hcl|gradle|xml|csv|env|lock|dockerfile';
const PATH_RE = new RegExp(String.raw`(?:^|[\s(\[\`'"])((?:[A-Za-z]:)?[\w@.~-]*(?:[\\/][\w@.~ -]*?)*[\w@~-]+\.(?:${CODE_EXT}))(?=$|[\s)\]\`'",;:!?]|\.(?:\s|$)|#L?\d)`, 'gi');

const CHANGE_VERB = /\b(updated|changed|modified|edited|created|added|wrote|written|rewrote|fixed|refactored|renamed|removed|deleted|replaced|moved|implemented|patched|adjusted|tweaked|introduced|extracted)\b/i;

// Words that make a sentence a hedge, a plan, a negation or an instruction
// rather than a report of something done.
const HEDGE = /\b(not|n't|never|without|unable|cannot|can't|couldn't|could not|didn't|did not|haven't|hasn't|failed to|if|whether|would|might|may|unless|once you|you can|you should|you'll|please|try running|to verify|next step|todo|will need|need to)\b/i;
const HARMLESS_NO = /\bno (errors?|failures?|warnings?|issues?|regressions?|problems?)\b|\bwithout (errors?|failures?|warnings?|issues?|any errors?)\b|\b0 fail(ed|ures?)?\b/gi;

const TEST_CLAIM = [
  /\b(all\s+)?(the\s+)?(\d+\s+)?(unit\s+|integration\s+|e2e\s+)?(tests?|specs?|test suite|test cases?)\b[^.\n]{0,40}?\b(now\s+)?(pass|passes|passed|passing|succeed|succeeds|succeeded|green|are green|all pass)\b/i,
  /\b(pass(es|ed|ing)?)\b[^.\n]{0,20}\b(all|every)\b[^.\n]{0,20}\b(tests?|specs?)\b/i,
  /\b(test suite|tests?)\b[^.\n]{0,20}\b(is|are)\s+(green|clean|passing)\b/i,
  /✅[^.\n]{0,30}\btests?\b|\btests?\b[^.\n]{0,30}✅/i,
];

const BUILD_CLAIM = [
  /\b(the\s+)?(build|compil(e|ation)|type[- ]?check(s|ing)?|tsc|lint(ing|er)?)\b[^.\n]{0,30}?\b(succeed(s|ed)?|pass(es|ed)?|is clean|are clean|works|completes|completed|successful(ly)?|is green|without errors|with no errors)\b/i,
  /\b(builds|compiles|type-?checks)\s+(successfully|cleanly|fine|without errors|with no errors)\b/i,
];

const DONE_CLAIM = [
  /\b(i('ve| have)?|we('ve| have)?|this|that|it|everything|the (bug|issue|problem|error|feature|change|task|fix))\b[^.\n]{0,40}?\b(is |are |has been |have been |now )?(fixed|resolved|done|complete|completed|implemented|finished|working( now)?|works( now| correctly| as expected)?)\b/i,
  /^\s*(done|fixed|all done|complete)[.!]/i,
  /\bshould (now )?(work|be fixed|be working|pass)\b/i,
];

/** @param {string|null|undefined} message @returns {Claims} */
export function extractClaims(message) {
  /** @type {Claims} */
  const claims = { tests: null, build: null, done: null, files: [] };
  if (!message) return claims;
  const text = stripCodeBlocks(String(message));
  for (const sentence of sentences(text)) {
    const assertive = !HEDGE.test(sentence.replace(HARMLESS_NO, ''));
    if (assertive) {
      if (!claims.tests && TEST_CLAIM.some((re) => re.test(sentence))) claims.tests = sentence;
      if (!claims.build && BUILD_CLAIM.some((re) => re.test(sentence))) claims.build = sentence;
      if (!claims.done && DONE_CLAIM.some((re) => re.test(sentence))) claims.done = sentence;
    }
    if (assertive || /^\s*([-*•]|\d+\.)\s/.test(sentence)) {
      for (const p of fileClaims(sentence)) {
        if (!claims.files.some((f) => f.path === p)) claims.files.push({ path: p, sentence });
      }
    }
  }
  return claims;
}

/**
 * Files a sentence says were changed. Two shapes count:
 *   "I updated `src/cart.js` to ..."   (the first path within 60 characters after a change verb)
 *   "- `src/cart.js`: fixed the total"  (a list item that starts with a path and has a change verb)
 * Other paths in the sentence are treated as references, not claims.
 * @param {string} sentence
 */
export function fileClaims(sentence) {
  const out = [];
  const listItem = /^\s*(?:[-*•]|\d+\.)\s*\**`?([^`\s:*]+\.[A-Za-z0-9]+)`?\**\s*(?:[:—–-]|\(new\))/.exec(sentence);
  if (listItem && CHANGE_VERB.test(sentence) && isPath(listItem[1])) {
    out.push(cleanPath(listItem[1]));
    return out;
  }
  if (HEDGE.test(sentence.replace(HARMLESS_NO, ''))) return out;
  const verb = CHANGE_VERB.exec(sentence);
  if (!verb) return out;
  const after = sentence.slice(verb.index + verb[0].length);
  PATH_RE.lastIndex = 0;
  const m = PATH_RE.exec(after);
  if (m && m.index <= 60) out.push(cleanPath(m[1]));
  return out;
}

/** @param {string} p */
function isPath(p) {
  PATH_RE.lastIndex = 0;
  return PATH_RE.test(` ${p} `);
}

/** @param {string} p */
function cleanPath(p) {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/#L?\d.*$/, '').replace(/:\d+(:\d+)?$/, '');
}

/** @param {string} text */
function stripCodeBlocks(text) {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)');
}

/** Splits into list items and sentences. @param {string} text */
export function sentences(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // Keep file names like "cart.test.js" whole: split only on ". " followed by a capital or a list marker.
    // The first piece of a list line keeps its bullet, which fileClaims uses.
    for (const s of line.split(/(?<=[.!?])\s+(?=[A-Z0-9*`"'-])/)) {
      if (s.trim()) out.push(s);
    }
  }
  return out;
}
