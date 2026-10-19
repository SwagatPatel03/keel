# Change log

## 0.7.0

- A new sidebar: the verdict with each check's counts, the task budget with its 70% and 90% marks, the prompts of the session, the changed files and the guard's decisions.
- A Changed Files view with file icons and line counts. Clicking a file compares it with how it was when the session started.
- Undo now shows a preview first, lets you untick files, asks before it changes anything, and can be put back.
- The status bar entry only opens the sidebar. It never starts an undo.
- The sidebar updates as soon as Keel records something, instead of re-reading on every editor event.
- The extension carries its own copy of Keel's command line, so it works on its own once Keel is installed in Claude Code.
