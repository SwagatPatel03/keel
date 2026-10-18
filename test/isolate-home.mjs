// Points Keel's home at a temporary folder, so no test writes to the real
// ~/.keel (for example the install key that file-name hashes use).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.KEEL_HOME) process.env.KEEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-test-home-'));
// No background checkpoint pruning from hooks during tests (it is tested directly).
process.env.KEEL_NO_BACKGROUND = '1';
