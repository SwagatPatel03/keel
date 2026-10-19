// Native reports only. Terminal phrases such as "tests passed" are not evidence.
export function parseReport(format, text) {
  if (format === 'node-events') return nodeEvents(text);
  if (format === 'node-tap') return tap(text);
  if (format === 'jest' || format === 'vitest') return jest(text);
  if (format === 'junit' || format === 'pytest') return junit(text);
  if (format === 'go') return go(text);
  throw new Error(`Unsupported report format: ${format}`);
}
function nodeEvents(text) {
  const records = text.trim().split('\n').map((line) => JSON.parse(line));
  if (records[0]?.type !== 'keel:header' || records[0]?.version !== 1 || records.at(-1)?.type !== 'keel:complete' || records.filter((r) => r.type === 'keel:complete').length !== 1) throw new Error('Incomplete native Node event report.');
  const summaries = records.filter((r) => r.type === 'test:summary' && !r.data.file && !r.data.entryFile);
  if (summaries.length !== 1) throw new Error('Native Node cumulative summary unavailable.');
  const counts = summaries[0].data.counts;
  if (counts.cancelled) throw new Error('Cancelled tests leave incomplete evidence.');
  const occurrences = new Map(), tests = [];
  for (const record of records.filter((r) => r.type === 'test:pass' || r.type === 'test:fail')) {
    const d = record.data;
    if (!['test', 'suite'].includes(d.kind)) throw new Error('Native Node test type unavailable.');
    if (d.kind === 'suite') continue;
    if (!d.file || typeof d.name !== 'string') throw new Error('Native Node test identity unavailable.');
    const base = `${d.entryFile || ''}::${d.file}:${d.line || 0}:${d.column || 0}::${d.name}`;
    const occurrence = (occurrences.get(base) || 0) + 1; occurrences.set(base, occurrence);
    tests.push({ id: `${base}::${occurrence}`, status: d.skip || d.todo ? 'skipped' : record.type === 'test:fail' ? 'failed' : 'passed' });
  }
  const passed = tests.filter((t) => t.status === 'passed').length, failed = tests.filter((t) => t.status === 'failed').length, skipped = tests.filter((t) => t.status === 'skipped').length;
  if (counts.passed !== passed || counts.failed !== failed || counts.skipped + counts.todo !== skipped) throw new Error('Native Node counts disagree with inventory.');
  if (typeof summaries[0].data.success !== 'boolean') throw new Error('Native Node suite verdict unavailable.');
  return { ...complete(tests, { discovered: counts.tests, executed: passed + failed, passed, failed, skipped }), suiteFailed: !summaries[0].data.success };
}
function complete(tests, counts) {
  const { discovered, executed, passed, failed, skipped } = counts;
  if (![discovered, executed, passed, failed, skipped].every(Number.isSafeInteger) || Object.values(counts).some((n) => n < 0)) throw new Error('Invalid test counts.');
  if (!discovered || !executed) throw new Error('Expected suite executed zero tests.');
  if (passed + failed !== executed || executed + skipped !== discovered || tests.length !== discovered || new Set(tests.map((t) => t.id)).size !== tests.length) throw new Error('Incomplete or ambiguous test inventory.');
  return { tests, ...counts };
}
function tap(text) {
  const summary = (name) => { const matches = [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))]; if (matches.length !== 1) throw new Error('Missing or repeated TAP summary.'); return Number(matches[0][1]); };
  if (!/^TAP version 13\s*$/m.test(text) || /^Bail out!/m.test(text)) throw new Error('Incomplete TAP report.');
  const tests = [];
  const stack = [];
  for (const line of text.split('\n')) {
    const heading = /^(\s*)# Subtest: (.+)$/.exec(line);
    if (heading) { const level = heading[1].length; while (stack.length && stack.at(-1).level >= level) stack.pop(); stack.push({ level, name: heading[2].trim() }); }
    const match = /^(\s*)(not )?ok \d+ - (.+?)(?: # (SKIP|TODO)\b.*)?$/.exec(line.trimEnd());
    if (!match) continue;
    const level = match[1].length;
    const name = match[3].replace(/\s+# (?:SKIP|TODO).*$/, '').trim();
    const skipped = / # (?:SKIP|TODO)\b/.test(line);
    const parents = stack.filter((item) => item.level < level).map((item) => item.name);
    // Node emits a "type: suite" diagnostic after suite result lines.
    tests.push({ id: [...parents, name].join(' > '), status: skipped ? 'skipped' : match[2] ? 'failed' : 'passed', level, suite: false });
    while (stack.length && stack.at(-1).level >= level) stack.pop();
  }
  // Suite result lines enclose child results. They are not test cases.
  const suites = summary('suites');
  if (suites) {
    for (let i = 1; i < tests.length; i++) if (tests[i - 1].level > tests[i].level) tests[i].suite = true;
    if (tests.filter((t) => t.suite).length !== suites) throw new Error('Unsupported TAP suite inventory.');
  }
  const inventory = tests.filter((t) => !t.suite).map(({ id, status }) => ({ id, status }));
  const discovered = summary('tests');
  const passed = summary('pass'); const failed = summary('fail'); const skipped = summary('skipped') + summary('todo');
  if (summary('cancelled')) throw new Error('Cancelled tests leave incomplete evidence.');
  return complete(inventory, { discovered, executed: passed + failed, passed, failed, skipped });
}
function jest(text) {
  const report = JSON.parse(text);
  if (!Array.isArray(report.testResults) || report.wasInterrupted) throw new Error('Incomplete JSON report.');
  const tests = report.testResults.flatMap((suite) => (suite.assertionResults || []).map((t) => ({ id: `${suite.name}::${t.fullName || [...(t.ancestorTitles || []), t.title].join(' > ')}`, status: ['pending', 'todo', 'skipped', 'disabled'].includes(t.status) ? 'skipped' : t.status })));
  if (tests.some((t) => !['passed', 'failed', 'skipped'].includes(t.status))) throw new Error('Unknown test result.');
  const passed = tests.filter((t) => t.status === 'passed').length, failed = tests.filter((t) => t.status === 'failed').length, skipped = tests.filter((t) => t.status === 'skipped').length;
  if (report.numTotalTests !== tests.length || report.numPassedTests !== passed || report.numFailedTests !== failed || (report.numPendingTests ?? skipped) !== skipped) throw new Error('JSON counts disagree with inventory.');
  if (report.numFailedTestSuites > 0 && failed === 0) throw new Error('A suite failed before collecting tests.');
  return { ...complete(tests, { discovered: tests.length, executed: passed + failed, passed, failed, skipped }), suiteFailed: report.success === false };
}
function junit(text) {
  const root = junitXml(text);
  if (!['testsuite', 'testsuites'].includes(root.name)) throw new Error('Invalid JUnit report root.');
  const descendants = (node, name) => node.children.flatMap((child) => [...(child.name === name ? [child] : []), ...descendants(child, name)]);
  const cases = descendants(root, 'testcase');
  const tests = cases.map((node) => {
    if (!node.attrs.name) throw new Error('JUnit test identity unavailable.');
    const outcomes = node.children.filter((child) => ['failure', 'error', 'skipped'].includes(child.name));
    if (new Set(outcomes.map((o) => o.name)).size > 1) throw new Error('Ambiguous JUnit test outcome.');
    return { id: `${node.attrs.classname || node.attrs.file || ''}::${node.attrs.name}`, status: outcomes.some((o) => o.name !== 'skipped') ? 'failed' : outcomes.length ? 'skipped' : 'passed' };
  });
  if (root.name === 'testsuites' && !descendants(root,'testsuite').length) throw new Error('JUnit suite inventory unavailable.');
  for (const suite of [root, ...descendants(root, 'testsuite')]) {
    const inventory = descendants(suite, 'testcase');
    const count = (name) => inventory.filter((node) => node.children.some((child) => child.name === name)).length;
    if ((suite.name === 'testsuite' || suite.attrs.tests !== undefined) && (!/^\d+$/.test(suite.attrs.tests || '') || Number(suite.attrs.tests) !== inventory.length)) throw new Error('JUnit inventory does not match declared tests.');
    for (const [attr, expected] of [['failures', count('failure')], ['errors', count('error')], ['skipped', count('skipped')]]) {
      if (suite.attrs[attr] !== undefined && (!/^\d+$/.test(suite.attrs[attr]) || Number(suite.attrs[attr]) !== expected)) throw new Error('JUnit outcome counts disagree with inventory.');
    }
  }
  const passed = tests.filter((t) => t.status === 'passed').length, failed = tests.filter((t) => t.status === 'failed').length, skipped = tests.filter((t) => t.status === 'skipped').length;
  return complete(tests, { discovered: tests.length, executed: passed + failed, passed, failed, skipped });
}
// A deliberately limited, strict XML reader. No external entities or recovery
// from malformed markup: unsupported reports must remain unverified.
function junitXml(text) {
  const decode = (value) => value.replace(/&([^;\s]+);|&/g, (match, entity) => {
    const names = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'"};
    if (Object.hasOwn(names, entity)) return names[entity];
    const code = /^#x[0-9a-f]+$/i.test(entity || '') ? parseInt(entity.slice(2),16) : /^#\d+$/.test(entity || '') ? Number(entity.slice(1)) : NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error('Invalid JUnit XML entity.');
    return String.fromCodePoint(code);
  });
  const tokens = /<\?xml\s[^?]*\?>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[\w:.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?>|[^<]+/g;
  const stack = []; let root = null, end = 0;
  for (const match of text.matchAll(tokens)) {
    if (match.index !== end) throw new Error('Invalid or incomplete JUnit XML.');
    end += match[0].length;
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?xml')) continue;
    if (token.startsWith('<![CDATA[')) { if (!stack.length) throw new Error('Invalid JUnit XML text.'); continue; }
    if (!token.startsWith('<')) { decode(token); if (!stack.length && token.trim()) throw new Error('Invalid JUnit XML text.'); continue; }
    const name = /^<\/?([\w:.-]+)/.exec(token)[1];
    if (token.startsWith('</')) { if (!/^<\/[\w:.-]+\s*>$/.test(token) || stack.pop()?.name !== name) throw new Error('Invalid or incomplete JUnit XML.'); continue; }
    const attrs = {};
    for (const attr of token.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)) {
      if (Object.hasOwn(attrs, attr[1])) throw new Error('Duplicate JUnit XML attribute.');
      attrs[attr[1]] = decode(attr[3]);
    }
    const node = {name, attrs, children:[]};
    if (stack.length) stack.at(-1).children.push(node);
    else { if (root) throw new Error('Multiple JUnit XML roots.'); root = node; }
    if (!token.endsWith('/>')) stack.push(node);
  }
  if (end !== text.length || stack.length || !root) throw new Error('Invalid or incomplete JUnit XML.');
  return root;
}
function go(text) {
  const rows = text.trim().split('\n').map((line) => JSON.parse(line));
  const packages = new Set(rows.filter((r) => !r.Test && r.Action === 'start').map((r) => r.Package));
  for (const pkg of packages) if (!rows.some((r) => r.Package === pkg && !r.Test && ['pass', 'fail', 'skip'].includes(r.Action))) throw new Error('Incomplete Go package.');
  if (rows.some((r) => !r.Test && r.Action === 'fail')) throw new Error('Go package failed.');
  const tests = rows.filter((r) => r.Test && ['pass', 'fail', 'skip'].includes(r.Action)).map((r) => ({ id: `${r.Package}::${r.Test}`, status: r.Action === 'pass' ? 'passed' : r.Action === 'fail' ? 'failed' : 'skipped' }));
  const passed = tests.filter((t) => t.status === 'passed').length, failed = tests.filter((t) => t.status === 'failed').length, skipped = tests.filter((t) => t.status === 'skipped').length;
  return complete(tests, { discovered: tests.length, executed: passed + failed, passed, failed, skipped });
}
