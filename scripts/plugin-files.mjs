#!/usr/bin/env node
// Rewrites hooks/hooks.json from src/plugin-files.mjs. Run it after changing
// the hook list or the guard's secret-file globs; a unit test fails until the
// file matches.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_LAUNCHER, claudeHooksText } from '../src/plugin-files.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.writeFileSync(path.join(root, 'hooks', 'hooks.json'), claudeHooksText(NODE_LAUNCHER));
console.log('Wrote hooks/hooks.json');
