// Reads token usage from a Claude Code session transcript (JSON Lines).
// Each assistant API response can span several transcript entries (one per
// content block) that repeat the same usage, so usage is counted once per
// message id. Totals include cache reads and writes, as ccusage does.

import fs from 'node:fs';

/**
 * Tokens used from the assistant message that issued `fromToolUseId` (inclusive)
 * to the end of the transcript. Without an id, counts the whole transcript.
 * @param {string|null|undefined} transcriptPath
 * @param {string|null} [fromToolUseId]
 * @returns {{total: number, output: number, messages: number}|null}
 */
export function tokensSince(transcriptPath, fromToolUseId = null) {
  let text;
  try { text = fs.readFileSync(String(transcriptPath), 'utf8'); } catch { return null; }
  const seen = new Set();
  let counting = !fromToolUseId;
  let total = 0;
  let output = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type !== 'assistant' || entry.isSidechain) continue;
    const msg = entry.message || {};
    if (!counting && Array.isArray(msg.content) && msg.content.some((c) => c?.type === 'tool_use' && c.id === fromToolUseId)) {
      counting = true;
    }
    if (!counting || !msg.usage) continue;
    const key = msg.id || entry.uuid;
    if (seen.has(key)) continue;
    seen.add(key);
    const u = msg.usage;
    const out = u.output_tokens || 0;
    output += out;
    total += (u.input_tokens || 0) + out + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  if (!counting) return null;
  return { total, output, messages: seen.size };
}

/** "41,000" style rounding for plain-English messages. @param {number} n */
export function roundTokens(n) {
  if (n >= 10000) return (Math.round(n / 1000) * 1000).toLocaleString('en-US');
  if (n >= 1000) return (Math.round(n / 100) * 100).toLocaleString('en-US');
  return String(n);
}
