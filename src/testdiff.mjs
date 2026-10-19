// Finds weakened tests in a diff: deleted test files, removed test cases and
// newly added skip or focus markers.

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|(^|\/)(test|spec)\.[cm]?[jt]sx?$|[._-](test|spec)s?\.[A-Za-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb|exs?)$|(^|\/)[^/]+Tests?\.(java|kt|cs|swift)$/i;

// Skipped and focused forms count as test cases too, so skipping a test is
// reported once (as a skip), not also as a removal.
const TEST_CASE = /^\s*(x|f)?(it|test|specify)(\.(skip|only|todo|concurrent|each\([^)]*\)))*\s*\(|^\s*(async\s+)?def\s+test_|^\s*#\[(tokio::)?test\]|^\s*func\s+Test\w+\s*\(|^\s*@Test\b|^\s*\[(Test|Fact|Theory)\]/gm;

const SKIP_MARKER = /\b(it|test|describe|context|suite)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(|\bf(it|describe)\s*\(|@pytest\.mark\.(skip|xfail)\b|@unittest\.skip|\bpytest\.skip\(|#\[ignore\]|\bt\.Skip(Now|f)?\(|@Disabled\b|@Ignore\b|\[Ignore\]|\[Fact\(Skip\s*=|\bskip:\s*true\b/g;

/** @param {string} file */
export function isTestFile(file) {
  return TEST_FILE.test(file);
}

/** @param {string|null} text @param {RegExp} re */
function count(text, re) {
  if (!text) return 0;
  re.lastIndex = 0;
  return (text.match(re) || []).length;
}

/**
 * @param {{status: string, path: string, oldPath?: string}[]} changes
 * @param {(file: string, side: 'before'|'after') => string|null} read  File content before or after the change.
 * @returns {{kind: 'deleted-test-file'|'removed-test-cases'|'added-skip', file: string, before?: number, after?: number}[]}
 */
export function findTestTampering(changes, read) {
  /** @type {{kind: 'deleted-test-file'|'removed-test-cases'|'added-skip', file: string, before?: number, after?: number}[]} */
  const findings = [];
  for (const c of changes) {
    const beforePath = c.oldPath || c.path;
    if (!isTestFile(beforePath) && !isTestFile(c.path)) continue;
    if (c.status === 'D') {
      const casesBefore = count(read(beforePath, 'before'), TEST_CASE);
      findings.push({ kind: 'deleted-test-file', file: beforePath, before: casesBefore, after: 0 });
      continue;
    }
    if (c.status !== 'M' && c.status !== 'R' && c.status !== 'A') continue;
    const before = read(beforePath, 'before');
    const after = read(c.path, 'after');
    const casesBefore = count(before, TEST_CASE);
    const casesAfter = count(after, TEST_CASE);
    if (casesAfter < casesBefore) findings.push({ kind: 'removed-test-cases', file: c.path, before: casesBefore, after: casesAfter });
    const skipsBefore = count(before, SKIP_MARKER);
    const skipsAfter = count(after, SKIP_MARKER);
    if (skipsAfter > skipsBefore) findings.push({ kind: 'added-skip', file: c.path, before: skipsBefore, after: skipsAfter });
  }
  return findings;
}
