// Evidence gate: compares what the agent says it did with what actually
// happened this turn. Deterministic; no model call.

/**
 * @typedef {object} GateInput
 * @property {import('./claims.mjs').Claims} claims
 * @property {any[]} turnEvents        This turn's tool_result events, in order.
 * @property {{status: string, path: string}[]} turnChanges     Files changed since the turn started.
 * @property {{status: string, path: string}[]} sessionChanges  Files changed since the session started.
 * @property {ReturnType<import('./testdiff.mjs').findTestTampering>} tampering
 * @property {string|null} testCommand
 * @property {string|null} buildCommand
 * @property {boolean} runChecks
 * @property {(command: string) => ReturnType<import('./checks.mjs').runCheck>} run
 * @property {boolean} [caseInsensitive]
 *
 * @typedef {object} Finding
 * @property {string} kind
 * @property {string} message  Plain-English sentence addressed to the agent.
 * @property {string} summary  Plain-English sentence for the user's receipt.
 */

/** @param {GateInput} input */
export function evaluate(input) {
  const { claims, turnEvents, turnChanges, sessionChanges, tampering } = input;
  /** @type {Finding[]} */
  const findings = [];
  /** @type {ReturnType<import('./checks.mjs').runCheck>[]} */
  const keelChecks = [];

  const lastEdit = lastIndex(turnEvents, (e) => e.ok && e.files?.length > 0);
  const lastTestIdx = lastIndex(turnEvents, (e) => e.isTest);
  const lastTest = lastTestIdx >= 0 ? turnEvents[lastTestIdx] : null;
  const testAfterEdit = lastTest && lastTestIdx > lastEdit;
  const lastBuildIdx = lastIndex(turnEvents, (e) => e.isBuild);
  const lastBuild = lastBuildIdx >= 0 ? turnEvents[lastBuildIdx] : null;
  const buildAfterEdit = lastBuild && lastBuildIdx > lastEdit;
  const changed = turnChanges.length > 0;

  /** Runs the project's tests once per turn, when allowed. */
  /** @type {ReturnType<import('./checks.mjs').runCheck>|null} */
  let testRun = null;
  const runTests = () => {
    if (testRun || !input.runChecks || !input.testCommand) return testRun;
    testRun = input.run(input.testCommand);
    keelChecks.push(testRun);
    return testRun;
  };

  // 1. "Tests pass"
  if (claims.tests) {
    if (testAfterEdit && !lastTest.ok) {
      findings.push(failedRun('tests-claim-failed', 'all tests pass', lastTest));
    } else if (!testAfterEdit && changed) {
      const r = runTests();
      if (r && !r.ok && !r.timedOut) findings.push(failedKeelRun('tests-claim-failed', 'all tests pass', r));
      else if (!r && !lastTest) findings.push({
        kind: 'tests-claim-unrun',
        message: 'You said the tests pass, but no test command ran after your last edit this turn. Run the tests and report the real result.',
        summary: 'Claude said the tests passed, but it had not run them after its last change.',
      });
      else if (!r && lastTest) findings.push({
        kind: 'tests-claim-stale',
        message: `You said the tests pass, but the last test run (\`${lastTest.command}\`) happened before your last edit. Run the tests again and report the real result.`,
        summary: 'Claude said the tests passed, but its last test run was older than its last change.',
      });
    }
  }

  // 2. "The build succeeds"
  if (claims.build && input.buildCommand) {
    if (buildAfterEdit && !lastBuild.ok) {
      findings.push(failedRun('build-claim-failed', 'the build succeeds', lastBuild));
    } else if (!buildAfterEdit && changed && input.runChecks) {
      const r = input.run(input.buildCommand);
      keelChecks.push(r);
      if (!r.ok && !r.timedOut) findings.push(failedKeelRun('build-claim-failed', 'the build succeeds', r));
    }
  }

  // 3. "Done" / "fixed"
  if (claims.done && !findings.length) {
    if (changed && testAfterEdit && !lastTest.ok) {
      findings.push(failedRun('done-claim-failing-tests', 'the work is done', lastTest));
    } else if (changed && !testAfterEdit) {
      const r = runTests();
      if (r && !r.ok && !r.timedOut) findings.push(failedKeelRun('done-claim-failing-tests', 'the work is done', r));
    } else if (!changed && sessionChanges.length === 0 && /\b(i|we)('ve| have)?\b[^.]{0,30}\b(fixed|implemented|added|updated|changed|created)\b/i.test(claims.done)) {
      findings.push({
        kind: 'done-claim-no-changes',
        message: 'You said you made a change, but no files changed in this session. Make the change, or tell the user plainly that nothing was changed.',
        summary: 'Claude said it had made a change, but no files had changed.',
      });
    }
  }

  // 4. Files the agent says it changed
  for (const claim of claims.files) {
    if (matchesAny(claim.path, turnChanges, input.caseInsensitive) || matchesAny(claim.path, sessionChanges, input.caseInsensitive)) continue;
    findings.push({
      kind: 'file-claim-unchanged',
      message: `You said you changed \`${claim.path}\`, but that file has no changes in this session. Make the change, or correct your summary.`,
      summary: `Claude said it changed ${claim.path}, but that file had no changes.`,
    });
  }

  // 5. Weakened tests
  for (const t of tampering) {
    const where = `\`${t.file}\``;
    const what = t.kind === 'deleted-test-file'
      ? `You deleted the test file ${where}${t.before ? ` (${t.before} test${t.before === 1 ? '' : 's'})` : ''}.`
      : t.kind === 'removed-test-cases'
        ? `You removed ${t.before - t.after} test case${t.before - t.after === 1 ? '' : 's'} from ${where}.`
        : `You added a skip or focus marker in ${where}, so some tests no longer run.`;
    findings.push({
      kind: t.kind,
      message: `${what} If the user asked for this, say so plainly in your final message. Otherwise restore the tests and fix the code instead.`,
      summary: t.kind === 'deleted-test-file' ? `Claude deleted the test file ${t.file}.`
        : t.kind === 'removed-test-cases' ? `Claude removed test cases from ${t.file}.`
          : `Claude skipped tests in ${t.file}.`,
    });
  }

  const passingEvidence =
    (testRun && testRun.ok) ||
    (lastTest && lastTest.ok && (testAfterEdit || !changed));
  const green = !!passingEvidence && findings.length === 0;
  return { findings, keelChecks, green };
}

/** The message Claude receives when the gate blocks. @param {Finding[]} findings */
export function blockReason(findings) {
  const lines = findings.map((f, i) => `${i + 1}. ${f.message}`);
  return [
    `Keel checked your final message against the evidence and found ${findings.length === 1 ? 'a problem' : `${findings.length} problems`}:`,
    ...lines,
    'Fix this, or tell the user plainly what is not done yet.',
  ].join('\n');
}

/** @param {string} kind @param {string} said @param {any} run */
function failedRun(kind, said, run) {
  const code = run.exitCode != null ? ` with exit code ${run.exitCode}` : '';
  return {
    kind,
    message: `You said ${said}, but your last run of \`${run.command}\` failed${code}${run.errorExcerpt ? `: ${run.errorExcerpt}` : '.'}`,
    summary: `Claude said ${said}, but its own last run of ${run.command} had failed.`,
  };
}

/** @param {string} kind @param {string} said @param {any} r */
function failedKeelRun(kind, said, r) {
  return {
    kind,
    message: `You said ${said}, but Keel ran \`${r.command}\` and it failed with exit code ${r.exitCode}: ${r.excerpt}`,
    summary: `Claude said ${said}, but Keel ran ${r.command} and it failed.`,
  };
}

/** @template T @param {T[]} list @param {(x: T) => boolean} pred */
function lastIndex(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}

/**
 * @param {string} claimed
 * @param {{path: string, oldPath?: string}[]} changes
 * @param {boolean} [ci]
 */
export function matchesAny(claimed, changes, ci) {
  const norm = (s) => (ci ? s.toLowerCase() : s).replace(/\\/g, '/').replace(/^\.\//, '');
  const c = norm(claimed);
  return changes.some((ch) => [ch.path, ch.oldPath].filter(Boolean).some((p) => {
    const d = norm(p);
    return d === c || d.endsWith('/' + c) || c.endsWith('/' + d);
  }));
}
