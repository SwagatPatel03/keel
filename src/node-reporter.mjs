// Materialized outside the candidate tree for Node's native reporter API.
// Keeping the source here also embeds it in compiled editions.
export const NODE_REPORTER = `export default async function* reporter(events) {
  yield JSON.stringify({ type: 'keel:header', version: 1 }) + '\\n';
  for await (const event of events) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      yield JSON.stringify({ type: event.type, data: { name: d.name, file: d.file, entryFile: d.entryFile, line: d.line, column: d.column, nesting: d.nesting, testNumber: d.testNumber, kind: d.details?.type, skip: !!d.skip, todo: !!d.todo } }) + '\\n';
    } else if (event.type === 'test:summary') {
      yield JSON.stringify({ type: event.type, data: { file: event.data.file, entryFile: event.data.entryFile, counts: event.data.counts, success: event.data.success } }) + '\\n';
    }
  }
  yield JSON.stringify({ type: 'keel:complete', version: 1 }) + '\\n';
}
`;
