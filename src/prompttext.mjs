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

// Picks among options the agent offered: "Both", "The first one", "Option B", "2".
const CHOICE_START = /^(both|either|neither)$/i;
const CHOICE = /^(both( of them)?|either( one)?|neither( of them)?|all( of them)?|none( of them)?|(the )?(first|second|third|fourth|last|other)( one| option)?|option [a-d1-4]|[a-d1-4][.)]?)$/i;

/**
 * A short answer to the agent ("Yes", "OK, go ahead", "No thanks", "Both",
 * "The second one"): it continues the current task instead of starting a new
 * one, so it is not sized or questioned. Six words or fewer, starting with a
 * reply word, or a pick among the options the agent offered.
 * @param {string|null|undefined} text  The user's own text (see userText).
 */
export function isReply(text) {
  const raw = String(text || '').trim();
  if (/[/\\]|\.\w{1,5}\b/.test(raw)) return false;
  const words = raw.split(/[\s,.!?;:]+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  return REPLY_START.test(words[0]) || CHOICE_START.test(words[0]) || CHOICE.test(raw.replace(/[\s.!?]+$/, ''));
}
