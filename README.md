# Keel

Keel keeps your coding agent honest and safe, and helps you steer it. It is free, and it works in Claude Code, Codex, GitHub Copilot CLI and Google Antigravity, with Cursor and OpenCode support built from their documentation.

**Before Claude starts:**

- **Task sizer.** Keel sizes each prompt as trivial, small, feature or risky, using local rules. Trivial and small prompts get no ceremony and no extra tokens. Feature prompts are asked to plan first in plan mode, using a short plan guide (at most 3 phases of 3 tasks, each ending with a test). Risky prompts (payments, auth, migrations, deploys, secrets) are also asked to say what could be lost and how to undo it. Start a prompt with `quick:` to skip planning, or `plan:` to force it.
- **Clarity check.** If a prompt shows two or more vague signs (for example "fix the bug" with no symptom and no page named), Claude asks you 1 to 3 short multiple-choice questions before starting. Clear prompts cost nothing.
- **Plan check.** When Claude presents a plan, Keel reads it with fixed rules. It looks for a missing test step, missing failure handling, files you did not mention, guesses, a missing undo for risky work, and plans that are too big. If it finds gaps, Claude asks you up to 3 questions a senior developer would ask and updates the plan first. Then you see the plan with a short plain-English checklist.

**While Claude works:**

- **Command guard.** Before a shell command runs, Keel reads it (including chains, `sudo`, `bash -c`, `powershell -Command` and `cmd /c`). Commands that cannot be undone and are never needed for coding, such as `rm -rf ~` or wiping a disk, are refused. Commands that are dangerous but sometimes needed, such as `git reset --hard`, `git push --force`, dropping a table or `terraform destroy`, make Claude Code ask you first. Keel explains in one sentence what would be lost, offers a safer alternative, and saves a checkpoint before asking.
- **Protected files.** Claude Code asks you before Claude reads or edits a secret file (`.env`, keys, credentials), because anything read is sent to the model provider. It also asks before edits to CI workflows, migrations and lockfiles. Edits inside `.git/` are refused.
- **Token budget.** Each prompt gets a budget from its size (trivial 40k, small 90k, feature or risky 450k budget units). Budget units weigh each kind of token by what it costs: output counts five times as much as input for Claude (six times for OpenAI's models), and re-reading the cached conversation counts a tenth. This is an estimate of what uses up your plan, because the vendors do not publish exactly how subscription limits are counted. Keel shows you a one-line warning at 70%, 90% and 100%, with the raw token count alongside. The warnings add nothing to Claude's context, and Claude carries on; you decide whether to stop, or set Keel to stop it at 100%.

**When Claude says it is done:**

- **Evidence gate.** When Claude says "done", "all tests pass" or "I updated `cart.js`", Keel checks that claim against what really happened: the actual file changes, the tests that actually ran, and whether any tests were deleted or skipped. If a claim has no evidence, Keel sends Claude back once with a short list of what is missing. It uses fixed rules, not another AI model, so it costs no extra tokens.
- **Loop breaker.** When the same error comes back three times, or a file is edited back and forth to the same content, Keel stops Claude. It tells you how many tokens the loop used and gives you a better prompt to try next.
- **Checkpoints and revert.** Keel saves your files at the start of every prompt. `/keel:revert` puts them back to the last point where the tests passed, and `/keel:revert undo` reverses that.

**Learning while you ship:**

- **Learning notes.** On a debugging prompt (for example "the cart total shows NaN when an item has no quantity"), Claude works as normal, then adds a short "What was wrong" section and asks you one open question that checks you understood the cause. Keel also asks Claude for a short "What is new" or "What was wrong" section, once, when a turn adds a new dependency, adds the project's first Dockerfile, CI workflow or migration, or fixes a test that failed along the way. Every other turn is unchanged, and Claude Code's normal output style stays on. Notes are on by default; `/keel:learn off` turns them off, and `quick:` skips them for one prompt.

**Footprint: about 157 tokens per session**, as measured with `claude plugin details`. On a clear, small prompt where Claude's claims match the evidence, Keel prints nothing and adds nothing to Claude's context. Feature prompts add about 90 to 130 tokens of instructions, plus the plan guide (about 1,100 tokens) that Claude reads only then. A debugging prompt adds about 90 tokens, and a learning request costs one extra short reply. CI fails any change that pushes the always-on cost above 1,000 tokens.

## Install

You need git on your PATH. In Claude Code, add Keel's marketplace once:

```
/plugin marketplace add SwagatPatel03/keel
```

Then install one Keel plugin, the one that fits your computer:

| If you have | Install | Download |
| --- | --- | --- |
| Node.js 18 or newer | `/plugin install keel@keel` | a few hundred KB |
| No Node.js, Windows on Intel or AMD | `/plugin install keel-windows-x64@keel` | about 37 MB |
| No Node.js, Mac with Apple silicon (M1 or newer) | `/plugin install keel-macos-arm64@keel` | about 24 MB |
| No Node.js, Mac with an Intel processor | `/plugin install keel-macos-x64@keel` | about 26 MB |
| No Node.js, Linux on Intel or AMD | `/plugin install keel-linux-x64@keel` | about 35 MB |
| No Node.js, Linux on ARM | `/plugin install keel-linux-arm64@keel` | about 35 MB |

The plugins without Node.js hold Keel compiled into one program. It is the same Keel, its commands are the same (`/keel:revert` and so on), and it is a little faster, because no Node.js has to start for each hook. Claude Code downloads it from Keel's GitHub release and checks it against a SHA-256 fingerprint in Keel's marketplace file, so a changed download is refused. Install only one Keel plugin; if you install two, Keel tells you at the start of a session.

Claude Code's own installer does not install Node.js. If you installed the `keel` plugin without Node.js, Claude Code shows "Stop hook error occurred" after each reply, and pressing Ctrl+O shows `Executable not found in $PATH: "node"`. Install Node.js, or switch to the plugin for your computer from the table.

To try Keel from a local copy without installing, start Claude Code with `claude --plugin-dir path/to/keel`.

### Codex

Keel ships a Codex plugin manifest (`.codex-plugin/plugin.json`) with its hooks in `hooks/codex-hooks.json`. Add this repository as a Codex plugin marketplace and install Keel from it (`codex plugin marketplace add`, then `/plugins` in Codex). Codex asks you to review and trust plugin hooks before they run; use `/hooks` to do that, or Keel will stay inactive.

Codex differs from Claude Code in a few ways, and Keel adapts:

- Codex has no plan-approval screen, so feature prompts ask Codex to post its plan and wait, and Keel checks the plan when Codex stops.
- Codex cannot show a permission prompt from a hook, so a command Keel would ask about is paused instead, and Codex is told to ask you in chat.
- Codex has no hook between tool batches, so after a loop Keel refuses further tool calls until your next message, and budget warnings appear before the next tool call.
- Codex has no Keel slash commands, so to turn learning notes off, run `node /path/to/keel/bin/keel.mjs learn off` in a terminal, or set `"learn": { "mode": "off" }` in the settings file. Codex's first learning note on your computer ends with a sentence that tells you this.
- `codex exec` (Codex 0.161.0) does not print messages that hooks show only to the user. In those runs you will not see Keel's budget warnings or its checklist next to a plan; the receipt still records them. Whether the interactive Codex screen shows them has not been checked yet.

### Cursor, Copilot CLI, OpenCode and Antigravity

For these agents, Keel adds its hooks to your user settings, so it runs in all your projects and writes nothing inside them. From a copy of Keel, run one line per agent you use:

```
node path/to/keel/bin/keel.mjs install cursor
node path/to/keel/bin/keel.mjs install copilot
node path/to/keel/bin/keel.mjs install opencode
node path/to/keel/bin/keel.mjs install antigravity
```

Without Node.js, run the compiled Keel instead, for example `path/to/keel.exe install copilot` (the program is in `bin/` inside the platform plugin, or in the zip on Keel's release page). It copies itself to `~/.keel/bin/` and points the agent's hooks there, so updating or removing the Claude Code plugin does not break them, and the agent does not need to find Node.js on its PATH. OpenCode is the exception: it runs Keel's JavaScript itself, so install it from Keel's source with Node.js once; OpenCode then needs no Node.js.

| Agent | Where Keel writes |
| --- | --- |
| Cursor | Adds its entries to `~/.cursor/hooks.json`, next to yours, after saving a backup |
| Copilot CLI | Its own file, `~/.copilot/hooks/keel.json` |
| OpenCode | Its own plugin file, `~/.config/opencode/plugins/keel.js` |
| Antigravity | A group named `keel` in `~/.gemini/config/hooks.json`, next to yours, after saving a backup |

`keel uninstall <agent>` removes only Keel's entries. `keel doctor` shows where Keel is installed and what it can do in each agent. Restart the agent after installing.

**Copilot CLI (1.0.98) and Antigravity (agy 1.4.2) were checked in real sessions on Windows.** In both, Keel stopped `git reset --hard` and a read of `.env`, sent the agent back after a false "done", and added a learning note to a debugging prompt. **Cursor and OpenCode are built from their documentation** and pass the same conformance tests, but have not been run in a real session yet. If something looks wrong, uninstall and tell us.

What changes from agent to agent:

- **Cursor and Copilot CLI** cannot add text when your prompt arrives. Keel still sizes the prompt then, and adds its plan-first, clarity or learning guidance to the first tool result of that prompt, which is usually before the first edit.
- **Cursor** asks you about a dangerous shell command, but it cannot ask from its file hooks, so for a secret file or a protected file it refuses and tells the agent to ask you.
- **Copilot CLI** guards the commands of its sub-agents too, but does not size, plan-check or evidence-gate a sub-agent's work, because its prompt comes from the main agent, not from you.
- **Antigravity** approved Keel's "ask" on its own when started with `--dangerously-skip-permissions`, so Keel pauses dangerous commands and secret files there instead, as it does in Codex, and tells the agent to ask you. Antigravity's hooks do not report a command's result; Keel reads it from Antigravity's transcript, where it appears a moment after the hook, and fills it in at the next hook. A command Antigravity runs in the background is filled in when its result arrives. Antigravity blocks every tool if its pre-tool hook crashes or answers without a decision, so Keel always answers "allow" explicitly.
- **OpenCode** runs Keel inside OpenCode, so it does not start Node.js for each hook. Keel's notices appear as toasts. OpenCode does not show Keel the tool calls of sub-agents started with its task tool (OpenCode issue #5894), so Keel cannot guard those.
- **Cursor, Copilot CLI and Antigravity** cannot show you a message from a hook, so budget warnings go only into the receipt. In these agents, as in Codex, a loop stop refuses further tool calls until your next message.
- In Cursor, Antigravity and Copilot, Keel's own follow-up (for example, after a false "done") arrives as a message that starts with `[Keel]`.

## What you will see

When you ask for a feature, Claude plans first. If the plan has gaps, Claude asks you questions like these before you approve it:

```
1) How should we check that this works: a new automated test, the existing tests, or a manual check you will do?
2) The plan assumes: "Every item has a name". Is that right?
```

Next to the plan, you see Keel's checklist:

```
Keel: the plan in plain words
  1. Phase 1: Search
  2. Add filterItems(items, query) to src/cart.mjs; an empty query returns all items.
  3. Add tests in test/cart.test.mjs for a match, no match and an empty query.
Keel checked: a test step: yes; failure handling: covered or not needed; files you did not mention: none; guesses: none found; size: 1 phase, 3 tasks.
```

When Claude claims something it cannot back up, Claude receives a message like this and keeps working:

```
Keel checked your final message against the evidence and found a problem:
1. You said all tests pass, but Keel ran `npm test` and it failed with exit code 1: … 2 failing
Fix this, or tell the user plainly what is not done yet.
```

Keel sends Claude back at most once per prompt, so it can never trap Claude in a loop of its own.

When Claude is stuck, Keel stops it and shows you:

```
Keel stopped Claude because the same error appeared 3 times (TypeError: items.reduce is not a function). These attempts used about 41,000 tokens.
Run /keel:revert to put your files back to the last state where the tests passed.
Then try a prompt like this, which asks for the cause before any more edits:
"Stop changing code for a moment. The error "TypeError: items.reduce is not a function" keeps coming back. Read the relevant code, explain in plain words why it happens, and propose one fix. Wait for my OK before editing."
```

The token figure includes the conversation that Claude re-reads on every attempt, which is most of the cost.

After a debugging prompt, Claude's answer ends with a short section like this:

```
What was wrong
When an item has no qty field, item.qty is undefined, and any number times undefined gives NaN. Once one NaN gets into the sum, the whole total becomes NaN. Next time a total shows NaN, check for a field that might be missing and is used in maths without a default.

Quick question: if the code had used item.qty || 1 instead of item.qty ?? 1, what would happen to an item someone set to qty: 0?
```

## Commands

| Command | What it does |
| --- | --- |
| `/keel:receipt` | Shows a plain-English summary of the session: claims blocked, loops stopped, tests run, and the last green checkpoint. |
| `/keel:revert` | Restores your files to the last green checkpoint. If there is none yet, it goes back to the start of the session. |
| `/keel:revert undo` | Puts back the files you had just before the last revert. |
| `/keel:plan` | Loads Keel's plan guide, if you want a short plan for any request. |
| `/keel:learn` | Shows whether learning notes are on. `/keel:learn off` or `/keel:learn on` changes it for all projects; add `here` to change only this project. |

In agents without Keel's slash commands, run the same things in a terminal inside your project: `node path/to/keel/bin/keel.mjs receipt`, `revert`, `revert undo` or `learn off`.

To keep the current task's token use on screen, add Keel's meter to Claude Code's status line in your settings (Keel does not change Claude Code's settings itself):

```json
{ "statusLine": { "type": "command", "command": "node /path/to/keel/bin/keel.mjs meter" } }
```

It prints a line such as `Keel: feature task, 41% of budget (185,000 of 450,000 units, 62,000 new tokens)`. You can also run `node /path/to/keel/bin/keel.mjs meter` in a terminal inside your project.

When a session ends, Keel writes its receipt. If Keel caught something, the next session in that project starts with a one-line note pointing you to `/keel:receipt`.

## One rules file for every agent

All six agents read `AGENTS.md`, so one file is enough. Claude Code reads it from version 2.1.277, but only when the project has no `CLAUDE.md`; when both exist, Claude Code reads only `CLAUDE.md`.

`node path/to/keel/bin/keel.mjs rules` checks your project and says what to do: create `AGENTS.md`, rename `CLAUDE.md` to it, or move rules out of files that only one agent reads (such as `.cursorrules` or `.github/copilot-instructions.md`). When the project has both `AGENTS.md` and `CLAUDE.md`, it offers to add `@AGENTS.md` as the first line of `CLAUDE.md`, so Claude Code reads both. It asks before it writes, and `keel rules --yes` says yes for you. Nothing is downloaded.

If you want each agent to keep its own rules file in its own format, tools such as [Ruler](https://github.com/intellectronica/ruler) and [rulesync](https://github.com/dyoshikawa/rulesync) generate them from one source.

## When Keel runs your tests

Keel runs the project's declared test command only when all of these are true: Claude claimed that tests pass, that the build works or that the work is done; files changed during that prompt; and Claude did not run the tests itself after its last edit. The run has a 120-second limit, and a run that times out never blocks Claude.

Keel finds the test command from `package.json` (the `test` script, using npm, pnpm, yarn or bun to match your lockfile), pytest settings, `Cargo.toml`, `go.mod` or a `test:` target in a `Makefile`. You can set it yourself, or turn checks off, in the settings file below.

## Your data

Keel keeps everything under `~/.keel/projects/<project-name>-<id>/` in your home folder. Nothing is written inside your project (except the `@AGENTS.md` line that `keel rules` adds after you say yes), and nothing is sent anywhere: Keel makes no network calls, downloads nothing and has no telemetry.

- **Session records** list tool calls, file names and short error excerpts. Secrets that look like API keys, tokens or passwords are masked. Your prompts and plans are never stored: Keel keeps only the size it gave each prompt, the names of the rules that fired, the kinds of plan gaps it found, and keyed hashes of file names you mentioned (used to tell whether a plan stays in scope). The key is made at random for your computer and kept in `~/.keel/install.key`, so the stored values cannot be matched by hashing a file list elsewhere.
- **Guard records** are kept only for commands and files Keel asked about or refused: the rule, the decision and a short excerpt with secrets masked. Commands that pass are not recorded by the guard.
- **Learning records** say only which kind of note was asked for and, for a new dependency, the package name from your manifest. Claude's explanation and your answer are never stored.
- **The agent's last reply (Cursor only).** Cursor sends the agent's reply in a separate hook from the one where Keel checks it, so Keel keeps the latest reply in a scratch file until the turn ends, then deletes it. Cursor also sends your account email with every hook; Keel never stores it.
- **Checkpoints** live in a separate git folder (`shadow.git`) that Keel owns. Keel never reads or changes your own `.git` folder, branches or history, and checkpoints work in folders without git too. Checkpoints follow your `.gitignore` and always skip `.env` files, keys, `node_modules`, build folders and logs, so revert never touches those. Once a day, Keel deletes checkpoints from sessions older than 30 days, and the oldest ones while a project's store is larger than 1 GB, in a background process. The latest checkpoint where the tests passed is always kept. `keel prune` does the same at once.

To remove everything Keel has stored, delete the `~/.keel` folder.

## Settings

Create `~/.keel/config.json` to change the defaults:

```json
{
  "runChecks": true,
  "checkTimeoutSec": 120,
  "loopThreshold": 3,
  "guard": {
    "mode": "beginner",
    "allow": ["^npm run reset-local-db$"],
    "protect": ["infra/*.tfvars"],
    "allowPaths": ["config/.env.test"]
  },
  "budgets": { "trivial": 40000, "small": 90000, "feature": 450000, "risky": 450000 },
  "budgetUnits": "weighted",
  "budget": { "onLimit": "warn" },
  "checkpoints": { "keepDays": 30, "maxSizeMB": 1024 },
  "learn": { "mode": "on" },
  "projects": {
    "/path/to/project": { "testCommand": "npm run test:unit", "buildCommand": "npm run typecheck" }
  }
}
```

- `guard.mode` is `beginner` (every rule pack: files, git, secrets, databases, cloud and infrastructure, publishing and deploys), `standard` (files, git, secrets and databases) or `off`.
- `guard.allow` lists regular expressions for commands that should never be questioned. `guard.protect` adds file patterns to ask about, and `guard.allowPaths` lists file patterns never to ask about. In Claude Code, Keel checks reads only for its built-in secret files (so ordinary reads start no Keel process), so your own `guard.protect` patterns are checked when Claude edits those files, not when it reads them.
- `budgets` are per task, in budget units when `budgetUnits` is `weighted` (the default), or in new tokens (input, output and cache writes) when it is `new-tokens`. A settings file that sets `budgets` without `budgetUnits` keeps counting in new tokens, so numbers you set before keep their meaning.
- `budget.onLimit` is `warn` (Claude carries on after the 100% warning) or `stop` (Keel stops the agent once at 100%: Claude Code is stopped, and other agents have their tool calls refused until your next message).
- `checkpoints.keepDays` and `checkpoints.maxSizeMB` set how long checkpoints are kept and how large a project's store may grow.
- `learn.mode` is `on` or `off`. A project entry can set its own `learn`, which `/keel:learn on here` does for you.

## Limits

- Keel reads claims with fixed patterns. It is built to miss a claim rather than invent one, so some unusual phrasings get through.
- Keel knows which commands were tests from their names (`npm test`, `pytest`, `go test` and similar). A custom script with an unusual name is not counted as a test run unless you set it as `testCommand`.
- Edits made through shell commands (for example `sed`) are seen in the file changes but not in the order of edits.
- The sizer, clarity check and plan check use word rules in English. They will misjudge some prompts and plans; `quick:` and `plan:` let you override the size, and you can skip any question.
- Claude may not follow Keel's instruction to plan first. The receipt counts feature prompts that were built without a plan being shown.
- In non-interactive runs (`claude -p`), plan mode cannot show an approval screen. Keel then checks the plan when Claude stops instead.
- No command guard catches everything. Keel unwraps common wrappers and normalises flags, but an obfuscated command can still slip through, and Keel cannot see what a script does once it is running (for example a cleanup step inside a script the agent wrote). Claude Code's own permissions and sandbox remain your main protection, and Keel's checkpoints only cover files inside the project, not databases or cloud resources. In beginner mode, the receipt says whether the agent's sandbox was on; in Claude Code, `/sandbox` turns it on.
- Token budgets are estimates from the agent's transcript, weighed by published API prices. They do not match Anthropic's or OpenAI's subscription accounting exactly, and work done by subagents is not counted.
- In non-interactive runs (`claude -p`), Claude Code cannot show a permission prompt, so a command Keel would ask about is refused there.
- Each hook starts a Keel process. On the Windows machine Keel was built on, that takes about 0.3 seconds per hook with Node.js and about 0.25 seconds with the compiled Keel. Shell and edit tool calls run two Keel hooks (the guard before, the record after), so each adds roughly half a second there. Reads and searches start no Keel process, except reads of secret files. Faster machines and macOS or Linux are usually quicker.
- Keel spots debugging prompts with English word rules, so a bug described without a symptom or an error is not tagged at the start. If Claude then fixes a failing test during that turn, Keel still asks for a note. Keel does not check that Claude's explanation is correct, and a flaky test that fails once and then passes can trigger a note about nothing.
- Claude Code, Codex, Copilot CLI and Antigravity support was checked in real sessions. Cursor and OpenCode support is built from their documentation and checked only with the conformance tests, so the first real session may show differences. `keel doctor` shows which is which.
- Token budgets work in Claude Code, Codex, Copilot CLI, Antigravity and OpenCode. Cursor is not known to record token use where Keel can read it, so the budget stays off there.
- When installed from the Node.js edition, Cursor and Antigravity run Keel's hook as `node ...`, so Node.js must be on the PATH those apps see; installing from the compiled Keel avoids that. Antigravity splits hook commands on spaces and keeps quote marks, so Keel's Antigravity hooks load Keel through a file URL, or run the compiled Keel by its short Windows path, neither of which has spaces.
- The compiled Keel plugins for macOS have been built but not yet run on a Mac.
- In Antigravity, Keel learns a command's result one hook later, so a repeated error is stopped one tool call later than in other agents.

## Development

```
npm install            # dev tools only; Keel has no runtime dependencies
npm test               # unit tests plus replay tests against test/seeded-repo
npm run typecheck      # JSDoc types checked by TypeScript
npm run budget         # always-on token cost; fails above 1,000
npm run plugin-files   # rewrites hooks/hooks.json (a test fails until it matches)
npm run build:binaries -- --test   # compiles this machine's Keel with Bun and runs every test against it
```

`hooks/hooks.json` is generated from `src/plugin-files.mjs`, so the Read filter stays in step with the guard's secret-file list and the compiled plugins get the same hooks. `scripts/build-binaries.mjs` needs [Bun](https://bun.sh) at build time only. It compiles `bin/keel.mjs` for five platforms, lays out a Claude Code plugin around each program, zips it, and with `--base-url` writes each zip's address and SHA-256 into `.claude-plugin/marketplace.json`. `.github/workflows/release.yml` does this for every `v*` tag and publishes the zips on the GitHub release.

The replay tests feed Claude Code hook payloads through the real hook entry point (`bin/keel.mjs`) against a copy of a small seeded project. They cover a false file claim, an untested "all tests pass", a deleted test, a skipped test, a repeated error, a file edited back and forth, revert and undo, the receipt, and a clear passing turn that must produce no output. Phase 2 adds the plan's 20 labelled prompts for the sizer, plans with missing tests, failure handling or scope, a plan held once at approval and at stop, and a check that no prompt or plan text reaches the store. Phase 3 adds the destructive-command suite (92 commands that must be refused or questioned, 47 everyday commands that must pass), protected-path cases, budget warnings at 70%, 90% and 100%, and a full Codex flow. Phase 4 adds learning notes: only the debugging prompts among the 20 labelled prompts are tagged, untagged turns print nothing, each mid-turn trigger fires once and after the evidence gate, and the opt-out and one-time notice work in Claude Code and Codex. The payload shapes come from a recorded Claude Code 2.1.291 session in `test/fixtures/claude-code/` and a recorded Codex 0.161.0 session in `test/fixtures/codex/`.

Phase 5 adds the conformance suite in `test/conformance/`: the same eight scenarios (a clear turn adds nothing, a catastrophic command is refused, a dangerous command is asked about or paused, a secret file needs your say-so, a false "done" is sent back once, three identical failures stop the loop, a debugging prompt gets a learning note, a feature prompt is told to plan first) run against all six agents through each one's real entry point. `test/conformance/drivers.mjs` holds one driver per agent with that agent's payload shapes. Agent-specific tests cover the places an adapter could break its agent, such as Cursor's permission hooks needing an answer even when Keel fails. `test/conformance/recorded.test.mjs` replays sessions recorded from Copilot CLI 1.0.98 and Antigravity agy 1.4.2 (in `test/fixtures/copilot/` and `test/fixtures/antigravity/`, with paths and the user name masked), and the Copilot and Antigravity drivers use those recorded shapes.

How it is put together:

- `src/adapters/claude-code.mjs` turns hook payloads into agent-neutral events (`src/events.mjs`), so other agents only need a new adapter.
- `src/handlers.mjs` decides what to do at each moment: checkpoint, sizing and clarity check at the start of a prompt, loop check after each tool call, plan check when a plan is presented, evidence gate at the end of a turn, receipt at the end of a session.
- `src/sizer.mjs`, `src/plancheck.mjs` and `src/guidance.mjs` hold the Phase 2 rules and the short texts Keel adds to Claude's context.
- `src/guard/` holds the command parser (`shell.mjs`), the rule packs (`rules.mjs`) and the protected paths (`paths.mjs`); `src/budget.mjs` meters tokens per task.
- `src/learn.mjs` tags debugging prompts, finds learning moments in a turn (new dependencies in six manifest formats, first files of a new kind, fixed failures), and holds the learning texts.
- `src/adapters/codex.mjs` maps Codex's hooks onto the same events, and `bin/codex-hook.cjs` launches Keel from Codex's `PLUGIN_ROOT`.
- `src/adapters/cursor.mjs`, `copilot.mjs` and `antigravity.mjs` do the same for those agents, with shared helpers in `common.mjs`. `src/agents.mjs` lists what each agent's hooks can do, and handlers read only those flags.
- `src/shim.mjs` runs one hook call from payload to output; `bin/keel.mjs` uses it for command hooks, and `opencode/plugin.mjs` uses it inside OpenCode through `src/adapters/opencode.mjs`.
- `src/install.mjs` holds `keel install`, `uninstall` and `doctor`; `src/rules.mjs` holds the `keel rules` check.
- `src/runtime.mjs` tells the Node.js edition from the compiled one; `src/sandbox.mjs` reads whether the agent's sandbox was on.
- `src/claims.mjs`, `src/gate.mjs`, `src/testdiff.mjs` and `src/loop.mjs` hold the rules, as pure functions with unit tests.
- `src/checkpoint.mjs` manages the shadow git checkpoints, and `src/store.mjs` manages `~/.keel`.

## License

MIT. See [LICENSE](LICENSE). Keel's plan guide is adapted from Superpowers by Jesse Vincent (MIT); see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
