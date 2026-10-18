// The text Keel adds to the agent's context, and the messages it shows the
// user. Each is added only on the path that needs it, so clear trivial and
// small prompts cost nothing. Keep these short: they are paid for in tokens.

/**
 * Instructions for the start of a turn, or null when none are needed.
 * @param {{size: string, signals: string[]}} sizing
 * @param {{ask: boolean, signs: string[], questions: string[]}} clarity
 * @param {string} guidePath  Absolute path to Keel's plan guide.
 * @param {{planTool?: boolean, name?: string}} [caps]  Whether the agent has plan mode (Claude Code) or not (Codex).
 */
export function turnGuidance(sizing, clarity, guidePath, caps = { planTool: true }) {
  const parts = [];
  const claude = caps.planTool !== false;
  if (clarity.ask) {
    const signs = clarity.signs.map((s) => SIGN_WORDS[s] || s).join('; ');
    parts.push(
      claude
        ? `[Keel] This request is unclear (${signs}). Before doing anything else, ask the user these questions in one AskUserQuestion call, each with 2 to 4 likely answers:`
        : `[Keel] This request is unclear (${signs}). Before doing anything else, ask the user these questions, each with 2 to 4 likely answers, and wait for the reply:`,
      ...clarity.questions.map((q, i) => `${i + 1}) ${q}`),
      'Then continue with their answers.',
    );
  }
  if (sizing.size === 'feature' || sizing.size === 'risky') {
    const why = sizing.signals.map((s) => s.replace(/^\w+( path)?: /, '')).join(', ');
    const kind = sizing.size === 'risky' ? 'a risky change' : 'a feature';
    parts.push(claude
      ? `[Keel] This request is sized as ${kind} (${why}). Plan before editing: enter plan mode, read ${guidePath}, write a short plan (at most 3 phases of at most 3 tasks, each phase ending with a test or check), and present it with ExitPlanMode. If plan mode is unavailable, post the plan and wait for approval. If the superpowers:writing-plans skill is available, you may use it instead, within the same size limit.`
      : `[Keel] This request is sized as ${kind} (${why}). Plan before editing: read ${guidePath}, post a short plan (at most 3 phases of at most 3 tasks, each phase ending with a test or check), and stop to wait for the user's approval before changing any file.`);
    if (sizing.size === 'risky') {
      parts.push('[Keel] Because this is risky: in the plan, say what could be lost or broken and how to undo it, and ask the user before any destructive step (deleting data, migrations, deploys, force-push).');
    }
  }
  return parts.length ? parts.join('\n') : null;
}

const SIGN_WORDS = {
  'no-symptom': 'no symptom is described',
  'no-target': 'no file, page or part of the app is named',
  'too-short': 'it is very short',
};

/**
 * The message Claude gets when Keel holds a plan for questions.
 * @param {ReturnType<import('./plancheck.mjs').checkPlan>} result
 * @param {'approval'|'stop'} when
 */
export function planHoldReason(result, when) {
  const lines = [
    '[Keel] Before this plan goes to the user for approval, Keel found gaps a senior developer would ask about:',
    ...result.gaps.map((g) => `- ${g.finding}`),
    'Ask the user these questions in one AskUserQuestion call, each with 2 to 4 likely answers and your recommended answer first:',
    ...result.questions.map((q, i) => `${i + 1}) ${q}`),
    when === 'approval'
      ? 'Then update the plan file with their answers and call ExitPlanMode again. Keel will not hold the plan a second time.'
      : 'Then update the plan with their answers and present it again for approval. Keel will not hold the plan a second time.',
  ];
  return lines.join('\n');
}

/**
 * The plain-English checklist shown to the user next to the plan.
 * @param {ReturnType<import('./plancheck.mjs').checkPlan>} result
 */
export function planChecklist(result) {
  const steps = result.checklist.length
    ? result.checklist.map((s, i) => `  ${i + 1}. ${s}`)
    : ['  (Keel could not find numbered steps in this plan.)'];
  const has = (kind) => !result.gaps.some((g) => g.kind === kind);
  const checks = [
    `a test step: ${has('no-test') ? 'yes' : 'no'}`,
    `failure handling: ${has('no-error-handling') ? 'covered or not needed' : 'missing'}`,
    `files you did not mention: ${has('out-of-scope') ? 'none' : 'yes, see the plan'}`,
    `guesses: ${has('assumption') ? 'none found' : 'yes, check them'}`,
    `size: ${result.phases || 1} ${result.phases === 1 ? 'phase' : 'phases'}, ${result.tasks} ${result.tasks === 1 ? 'task' : 'tasks'}`,
  ];
  return ['Keel: the plan in plain words', ...steps, `Keel checked: ${checks.join('; ')}.`].join('\n');
}
