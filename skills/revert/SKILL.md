---
name: revert
description: Restore project files to Keel's last green checkpoint (add "undo" to reverse the last revert).
argument-hint: "[undo]"
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Keel has already run the revert. This is what it printed:

--- Keel output ---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/keel.mjs" revert $ARGUMENTS`
--- end of Keel output ---

Repeat Keel's output to the user word for word, with nothing added. Do not run any commands and do not change any files. From now on, treat the project files as they are after this revert.
