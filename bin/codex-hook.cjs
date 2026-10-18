#!/usr/bin/env node
// Codex hook launcher. Codex gives plugin hooks the plugin's folder in the
// PLUGIN_ROOT environment variable; reading it here avoids shell-specific
// variable syntax (bash, PowerShell and cmd all differ) in hooks.json.
//
// hooks/codex-hooks.json runs:
//   node -e "require(require('path').join(process.env.PLUGIN_ROOT,'bin','codex-hook.cjs'))" <EventName>
// so the event name is the last argument (with -e there is no script path in argv).

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = process.env.PLUGIN_ROOT || path.resolve(__dirname, '..');
const event = process.argv[process.argv.length - 1];

import(pathToFileURL(path.join(root, 'bin', 'keel.mjs')).href)
  .then((keel) => keel.main(['hook', event, 'codex']))
  .catch(() => { process.exitCode = 0; });
