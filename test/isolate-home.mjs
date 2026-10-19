// Points Keel's home at a temporary folder, so no test writes to the real
// ~/.keel (for example the install key that file-name hashes use).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.KEEL_HOME) process.env.KEEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-test-home-'));
// No background checkpoint pruning from hooks during tests (it is tested directly).
process.env.KEEL_NO_BACKGROUND = '1';
// Tests behave the same inside an editor's terminal as outside one (the
// extension offer in editor-offer.mjs is tested with its own values).
for (const name of ['CLAUDE_CODE_ENTRYPOINT', 'TERM_PROGRAM', 'VSCODE_PID', 'VSCODE_IPC_HOOK', 'VSCODE_IPC_HOOK_CLI', 'VSCODE_CWD', 'VSCODE_GIT_ASKPASS_NODE', 'CURSOR_TRACE_ID']) delete process.env[name];
