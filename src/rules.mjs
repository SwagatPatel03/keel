// keel rules: one rules file for every agent. All six agents Keel supports read
// AGENTS.md (Claude Code 2.1.277 and newer reads it when the project has no
// CLAUDE.md), so Keel checks which rules files a project has and recommends
// one AGENTS.md. It downloads nothing, and it writes only one thing, only when
// the user says yes: an @AGENTS.md line at the top of CLAUDE.md, so Claude
// Code reads AGENTS.md too when both files exist.

import fs from 'node:fs';
import path from 'node:path';

/** The line that makes Claude Code load AGENTS.md from CLAUDE.md. */
export const IMPORT_LINE = '@AGENTS.md';

// Files that only one agent reads, whose rules belong in AGENTS.md.
const SINGLE_AGENT_FILES = [
  { file: '.cursorrules', agent: 'Cursor (older format)' },
  { file: '.cursor/rules', agent: 'Cursor', dir: true },
  { file: '.github/copilot-instructions.md', agent: 'GitHub Copilot' },
  { file: 'GEMINI.md', agent: 'Gemini CLI and Antigravity' },
  { file: '.agent/rules', agent: 'Antigravity', dir: true },
  { file: '.windsurfrules', agent: 'Windsurf' },
];

/**
 * What rules files a project has, and what Keel recommends.
 * @param {string} root
 */
export function checkRules(root) {
  const has = (/** @type {string} */ rel) => fs.existsSync(path.join(root, rel));
  const claudeFile = ['CLAUDE.md', '.claude/CLAUDE.md'].find(has) || null;
  const claudeText = claudeFile ? fs.readFileSync(path.join(root, claudeFile), 'utf8') : '';
  const imports = new RegExp(`^\\s*${IMPORT_LINE.replace('.', '\\.')}\\s*$`, 'm').test(claudeText);
  return {
    agents: has('AGENTS.md'),
    claudeFile,
    imports,
    others: SINGLE_AGENT_FILES.filter((f) => has(f.file)),
    ruler: has('.ruler'),
  };
}

/** @param {ReturnType<typeof checkRules>} r */
export function canLink(r) {
  return r.agents && !!r.claudeFile && !r.imports;
}

/**
 * The report, in plain words.
 * @param {ReturnType<typeof checkRules>} r
 */
export function rulesReport(r) {
  const lines = [];
  if (!r.agents && !r.claudeFile) {
    lines.push('This project has no AGENTS.md. Create one with your project rules: Claude Code, Codex, Cursor, Copilot, OpenCode and Antigravity all read it.');
  } else if (r.agents && !r.claudeFile) {
    lines.push('This project has AGENTS.md and no CLAUDE.md, so all six agents read the same rules (Claude Code reads AGENTS.md from version 2.1.277).');
  } else if (!r.agents && r.claudeFile) {
    lines.push(`This project has ${r.claudeFile} but no AGENTS.md. Only Claude Code reads ${r.claudeFile}. Rename it to AGENTS.md so every agent reads it; Claude Code reads AGENTS.md too when there is no CLAUDE.md.`);
  } else if (r.imports) {
    lines.push(`This project has AGENTS.md, and ${r.claudeFile} loads it with ${IMPORT_LINE}, so every agent reads the same rules.`);
  } else {
    lines.push(`This project has AGENTS.md and ${r.claudeFile}. Claude Code reads only ${r.claudeFile} when it exists, so it does not see AGENTS.md. Adding ${IMPORT_LINE} as the first line of ${r.claudeFile} makes it read both.`);
  }
  if (r.others.length) {
    lines.push('', 'These files are read by one agent only. Move what they say into AGENTS.md, so every agent follows it:');
    for (const o of r.others) lines.push(`  - ${o.file} (${o.agent})`);
  }
  if (r.ruler) lines.push('', 'This project also uses Ruler (.ruler/). Ruler writes each agent\'s own file from .ruler/; keep editing there if you prefer that.');
  return lines.join('\n') + '\n';
}

/**
 * Adds the import line at the top of the project's CLAUDE.md. Call it only
 * after the user said yes.
 * @param {string} root @param {ReturnType<typeof checkRules>} r
 */
export function linkAgents(root, r) {
  if (!canLink(r) || !r.claudeFile) return `Nothing to change.\n`;
  const file = path.join(root, r.claudeFile);
  fs.writeFileSync(file, `${IMPORT_LINE}\n\n${fs.readFileSync(file, 'utf8')}`);
  return `Added ${IMPORT_LINE} as the first line of ${r.claudeFile}. Claude Code now reads AGENTS.md as well.\n`;
}

/**
 * keel rules [--yes]: the report, and the offer to add the import line. In a
 * terminal Keel asks; elsewhere --yes says yes.
 * @param {string} root
 * @param {{yes?: boolean, ask?: (question: string) => Promise<boolean>}} [o]
 * @returns {Promise<string>}
 */
export async function runRules(root, o = {}) {
  const r = checkRules(root);
  let text = rulesReport(r);
  if (!canLink(r)) return text;
  const yes = o.yes || (o.ask ? await o.ask(`Add ${IMPORT_LINE} to ${r.claudeFile}? (y/n) `) : false);
  if (yes) return text + '\n' + linkAgents(root, r);
  text += o.ask ? '\nNothing was changed.\n' : `\nTo add it, run keel rules --yes.\n`;
  return text;
}
