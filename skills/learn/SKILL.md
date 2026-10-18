---
name: learn
description: Show or change Keel's learning notes (add "on" or "off", and "here" for this project only).
argument-hint: "[on|off] [here]"
disable-model-invocation: true
allowed-tools: Bash(node *)
---

Keel has already applied the setting. This is what it printed:

--- Keel output ---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/keel.mjs" learn $ARGUMENTS`
--- end of Keel output ---

Repeat Keel's output to the user word for word, with nothing added. Do not run any commands and do not change any files.
