// What the user actually typed. Agents, IDEs and browser extensions add their
// own blocks to a prompt before Keel's hook sees it (a browser extension's tool
// instructions, the file open in the IDE, reminders). Keel sizes, questions and
// tags only what is left, so words in those blocks never count as the request.

// Blocks added by the agent or its extensions, removed wherever they appear.
const AGENT_BLOCK = /<(browser_instructions?|system-reminder|ide_[a-z_]+|user-prompt-submit-hook|local-command-[a-z]+|command-(?:name|message|args)|bash-(?:input|stdout|stderr)|task-notification)\b[^>]*>[\s\S]*?<\/\1>/g;

/**
 * The prompt without agent-added blocks, or null when there was no prompt.
 * @param {string|null|undefined} prompt
 */
export function userText(prompt) {
  if (prompt == null) return null;
  return String(prompt).replace(AGENT_BLOCK, '').trim();
}

// Words that open a reply to the agent's last question rather than a new request.
const REPLY_START = /^(y|yes|yeah|yep|yup|ok|okay|sure|no|nope|nah|go|proceed|continue|approved?|agreed|lgtm|please|fine|correct|right|exactly|thanks|thank)$/i;

/**
 * A short answer to the agent ("Yes", "OK, go ahead", "No thanks"): it
 * continues the current task instead of starting a new one, so it is not sized
 * or questioned. Six words or fewer, starting with a reply word.
 * @param {string|null|undefined} text  The user's own text (see userText).
 */
export function isReply(text) {
  const words = String(text || '').trim().split(/[\s,.!?;:]+/).filter(Boolean);
  return words.length > 0 && words.length <= 6 && REPLY_START.test(words[0]) && !/[/\\]|\.\w{1,5}\b/.test(String(text));
}
