// /keel:revert: restore the project's files to the last green checkpoint.

import { Shadow } from './checkpoint.mjs';

/** @param {import('./store.mjs').ProjectStore} store @returns {string} */
export function revert(store) {
  const session = store.listSessions()[0];
  if (!session) return 'Keel has no checkpoints for this project yet, so there is nothing to revert to.\n';
  const shadow = new Shadow(store).init();

  let target = shadow.resolve(shadow.ref(session, 'green'));
  let label = 'the last green checkpoint (the last point where the tests passed)';
  if (!target) {
    target = shadow.resolve('refs/keel/green');
    label = 'the last green checkpoint from an earlier session (the last point where the tests passed)';
  }
  if (!target) {
    const first = store.readSession(session).find((e) => e.kind === 'turn_start' && e.checkpoint);
    target = first?.checkpoint || null;
    label = 'the start of this session, because no turn has ended with passing tests yet';
  }
  if (!target) return 'Keel has no checkpoints for this project yet, so there is nothing to revert to.\n';

  const { changes } = shadow.restore(session, target);
  return describe(changes, `Keel restored your project files to ${label}${savedAt(shadow, target)}.`, true);
}

/** @param {import('./store.mjs').ProjectStore} store @returns {string} */
export function undoRevert(store) {
  const session = store.listSessions()[0];
  const shadow = new Shadow(store).init();
  const target = session ? shadow.resolve(shadow.ref(session, 'before-revert')) : null;
  if (!target) return 'There is no revert to undo in the latest session.\n';
  const { changes } = shadow.restore(session, target);
  return describe(changes, 'Keel undid the last revert and put back the files you had just before it.', false);
}

/**
 * @param {{status: string, path: string}[]} changes  From the current state (before) to the target (after).
 * @param {string} headline
 * @param {boolean} offerUndo
 */
function describe(changes, headline, offerUndo) {
  const lines = [headline];
  if (!changes.length) {
    lines.push('Your files already matched that checkpoint, so nothing changed.');
  } else {
    const restored = changes.filter((c) => c.status === 'M' || c.status === 'R');
    // The diff runs from the current files to the checkpoint: "D" means the
    // restore removed a file, and "A" means it brought one back.
    const removed = changes.filter((c) => c.status === 'D');
    const added = changes.filter((c) => c.status === 'A');
    if (restored.length) lines.push(`Changed back: ${list(restored)}.`);
    if (added.length) lines.push(`Brought back (they had been deleted): ${list(added)}.`);
    if (removed.length) lines.push(`Removed (they were created after the checkpoint): ${list(removed)}.`);
  }
  if (offerUndo) lines.push('Your files from just before this revert are saved. To undo the revert, run /keel:revert undo.');
  lines.push('Files that Keel never saves (such as .env, node_modules and anything in .gitignore) were not touched.');
  return lines.join('\n') + '\n';
}

/** @param {{path: string}[]} items */
function list(items) {
  const names = items.slice(0, 8).map((c) => c.path);
  return names.join(', ') + (items.length > 8 ? `, and ${items.length - 8} more` : '');
}

/** @param {Shadow} shadow @param {string} commit */
function savedAt(shadow, commit) {
  const d = shadow.commitDate(commit);
  return d ? `, saved at ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
}
