// Detects doom loops from the session's events:
//   - the same normalised error `threshold` times (across turns), until the
//     same command succeeds or Keel has already stopped that loop;
//   - a file returning to the same content `threshold` times (edited back and
//     forth), counting its content before the first edit.

/**
 * @typedef {{kind: 'error', fingerprint: string, count: number, firstToolUseId: string|null, excerpt: string|null, command: string|null}
 *          | {kind: 'edit', file: string, count: number, firstToolUseId: string|null}} Loop
 */

/**
 * Checks whether the latest event completes a loop.
 * @param {any[]} events  Session events in order, ending with the latest tool_result.
 * @param {number} threshold
 * @returns {Loop|null}
 */
export function detectLoop(events, threshold) {
  const last = events[events.length - 1];
  if (!last || last.kind !== 'tool_result') return null;

  /** @type {Map<string, {count: number, first: string|null, commands: Set<string>, excerpt: string|null, command: string|null}>} */
  const errors = new Map();
  /** @type {Map<string, {seen: Map<string, number>, first: string|null}>} */
  const files = new Map();

  for (const e of events) {
    if (e.kind === 'loop') {
      if (e.loop?.kind === 'error') errors.delete(e.loop.fingerprint);
      if (e.loop?.kind === 'edit') files.delete(e.loop.file);
      continue;
    }
    if (e.kind !== 'tool_result') continue;

    if (!e.ok && e.errorFingerprint) {
      const cur = errors.get(e.errorFingerprint) || { count: 0, first: e.toolUseId, commands: new Set(), excerpt: e.errorExcerpt, command: e.command };
      cur.count += 1;
      if (e.commandKey) cur.commands.add(e.commandKey);
      errors.set(e.errorFingerprint, cur);
    } else if (e.ok && e.commandKey) {
      for (const [fp, cur] of errors) if (cur.commands.has(e.commandKey)) errors.delete(fp);
    }

    if (e.ok && e.fileHash && e.files?.length) {
      const file = e.files[0];
      const cur = files.get(file) || { seen: new Map(), first: e.toolUseId };
      if (cur.seen.size === 0 && e.originalHash) cur.seen.set(e.originalHash, 1);
      cur.seen.set(e.fileHash, (cur.seen.get(e.fileHash) || 0) + 1);
      files.set(file, cur);
    }
  }

  if (!last.ok && last.errorFingerprint) {
    const cur = errors.get(last.errorFingerprint);
    if (cur && cur.count >= threshold) {
      return { kind: 'error', fingerprint: last.errorFingerprint, count: cur.count, firstToolUseId: cur.first, excerpt: cur.excerpt, command: cur.command };
    }
  }
  if (last.ok && last.fileHash && last.files?.length) {
    const cur = files.get(last.files[0]);
    const n = cur?.seen.get(last.fileHash) || 0;
    if (cur && n >= threshold) return { kind: 'edit', file: last.files[0], count: n, firstToolUseId: cur.first };
  }
  return null;
}
