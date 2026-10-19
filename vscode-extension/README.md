# Keel for Claude Code

Keel checks an AI coding agent's work while it happens. This extension shows what Keel found, in VS Code's sidebar, so you can see at a glance whether the work is really done.

It needs the Keel plugin in Claude Code, which does the checking. In Claude Code, run these two commands once:

```
/plugin marketplace add SwagatPatel03/keel
/plugin install keel@keel
```

After that, open the anchor icon in the activity bar. There is nothing else to set up.

## What the sidebar shows

**The verdict.** "Verified" means the project's own checks ran on a separate copy of the project with the original tests frozen, and they passed. "Checks failed" means a check ran and failed. "Not verified" means there is no current evidence either way. The **Run the checks now** button gets a fresh verdict.

**The budget.** How much of the current task's budget the agent has used, with marks at 70% and 90%, where Keel warns the agent.

**The prompts.** Each prompt of the session and how it ended. A star marks a prompt that ended with passing checks.

**The changed files.** Every file the agent changed in this session, with lines added and removed. Click a file to compare it with how it was when the session started.

**The guard.** The commands Keel refused, or asked you about, during this session.

The status bar shows the verdict and the budget too. Clicking it opens the sidebar.

## Undo, carefully

Nothing in this extension changes a file without asking first.

1. **Preview undo** lists each file and what would happen to it. Nothing has changed at this point.
2. Untick any file you want to keep.
3. Confirm, and Keel restores the rest. It saves the current files first.
4. **Put back** reverses the undo if you change your mind.

If you edited a file after the agent did, Keel will not overwrite your edit. It tells you which file is in the way and changes nothing.

You can also undo a single file with the button next to it in **Changed Files**.

## Privacy

The extension reads Keel's records on your computer and runs Keel's command line, which is included in the extension. It sends nothing anywhere.

## Commands

All commands are under **Keel** in the Command Palette: *Show the Keel Sidebar*, *Refresh*, *Run the Checks Now*, *Preview Undo of This Session…*, *Put Back the Last Undo* and *Open the Session Receipt*.

## Requirements

VS Code 1.90 or newer, or Cursor. Git must be installed, because Keel keeps its checkpoints in a private git store.
