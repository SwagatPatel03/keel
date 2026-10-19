import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport } from '../../src/reports.mjs';

test('Jest and Vitest reports reconcile the full test inventory and denominators', () => {
  const report = { numTotalTests: 3, numPassedTests: 1, numFailedTests: 1, numPendingTests: 1, testResults: [{ name: 'suite', assertionResults: [{ fullName: 'passes', status: 'passed' }, { fullName: 'fails', status: 'failed' }, { fullName: 'approved skip', status: 'pending' }] }] };
  for (const format of ['jest', 'vitest']) {
    const result = parseReport(format, JSON.stringify(report));
    assert.equal(result.discovered, 3); assert.equal(result.executed, 2); assert.equal(result.skipped, 1); assert.equal(result.failed, 1);
    assert.throws(() => parseReport(format, JSON.stringify({ ...report, numTotalTests: 2 })), /disagree/);
    assert.throws(() => parseReport(format, JSON.stringify({ ...report, wasInterrupted: true })), /Incomplete/);
  }
});
test('JUnit rejects incomplete, zero-test and entity-bearing reports', () => {
  const report = '<testsuites><testsuite tests="3"><testcase classname="suite" name="pass"/><testcase classname="suite" name="fail"><failure/></testcase><testcase classname="suite" name="skip"><skipped/></testcase></testsuite></testsuites>';
  const result = parseReport('junit', report);
  assert.equal(result.discovered, 3); assert.equal(result.failed, 1); assert.equal(result.skipped, 1);
  assert.throws(() => parseReport('pytest', report.replace('tests="3"', 'tests="4"')), /inventory/);
  assert.throws(() => parseReport('junit', report.slice(0, -14)), /incomplete/);
  assert.throws(() => parseReport('junit', '<!DOCTYPE x>' + report), /Invalid/);
  assert.throws(() => parseReport('junit', '<testsuite tests="0"></testsuite>'), /zero tests/);
  assert.throws(() => parseReport('junit', '<testsuite tests="1" failures="1"><testcase name="pass"/></testsuite>'), /disagree/);
  assert.throws(() => parseReport('junit', '<testsuites failures="1"><testsuite tests="1"><testcase name="pass"/></testsuite></testsuites>'), /disagree/);
  assert.throws(() => parseReport('junit', '<testsuite tests="1"><testcase name="pass"></wrong></testsuite>'), /incomplete/);
  assert.throws(() => parseReport('junit', '<testsuite tests="1"><testcase name="pass"/><unexpected></testsuite>'), /incomplete/);
  const nested = '<testsuites><testsuite tests="1"><testsuite tests="1"><testcase classname="a&#38;b" name="works"/></testsuite></testsuite></testsuites>';
  assert.equal(parseReport('junit', nested).tests[0].id, 'a&b::works');
});
test('Go JSON requires completed packages and stable package/test identifiers', () => {
  const rows = [{ Action: 'start', Package: 'example' }, { Action: 'run', Package: 'example', Test: 'TestOne' }, { Action: 'pass', Package: 'example', Test: 'TestOne' }, { Action: 'skip', Package: 'example', Test: 'TestSkipped' }, { Action: 'pass', Package: 'example' }];
  const stringify = (items) => items.map((r) => JSON.stringify(r)).join('\n');
  const result = parseReport('go', stringify(rows));
  assert.equal(result.discovered, 2); assert.equal(result.tests[0].id, 'example::TestOne');
  assert.throws(() => parseReport('go', stringify(rows.slice(0, -1))), /Incomplete/);
});
test('TAP requires a complete single summary; terminal success prose cannot pass', () => {
  const text = 'TAP version 13\n# Subtest: works\nok 1 - works\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(parseReport('node-tap', text).passed, 1);
  assert.throws(() => parseReport('node-tap', text + '# tests 1\n'), /repeated/);
  assert.throws(() => parseReport('node-tap', 'all tests pass'), /Incomplete/);
});
