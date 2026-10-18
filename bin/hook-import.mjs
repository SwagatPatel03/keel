// Hook entry for agents that split a hook command on spaces and keep quote
// marks literally (Antigravity's agy 1.4.2 on Windows, seen in a live run), so
// a script path with a space in it cannot be passed. The installer writes
//
//   node --import=file:///<keel>/bin/hook-import.mjs -e 0 <agent> <Event>
//
// A file URL has no spaces (they become %20), and "-e 0" gives Node an empty
// main script, so this module does the work.

import { main } from './keel.mjs';

const [agent, event] = process.argv.slice(-2);
await main(['hook', event, agent]);
