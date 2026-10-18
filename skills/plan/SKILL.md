---
name: plan
description: Keel's short planning guide for feature-sized work (brainstorm briefly, then a plan of at most 3 phases of 3 tasks).
disable-model-invocation: true
---

<!--
Adapted from Superpowers' "brainstorming" and "writing-plans" skills
(https://github.com/obra/superpowers), Copyright (c) 2025 Jesse Vincent,
MIT License. See THIRD_PARTY_NOTICES.md. Trimmed by Keel for feature-sized
tasks: one short planning pass instead of a design document and a full plan.
-->

# Keel plan guide

Keel sized this request as a feature, so plan before you build. The person reading your plan may be new to programming. Write so they can judge it.

## 1. Check what you actually know

Before planning, ask yourself what you know about what they want and why.

- If everything that matters is in the request, plan straight away.
- If something that changes what gets built is missing, ask about it first, in one AskUserQuestion call with 2 to 4 likely answers per question and your recommended answer first. Ask only what changes the outcome. Never ask "is this plan OK?"; presenting the plan does that.

Read the code the change touches before deciding anything. Build on what the project already uses.

## 2. Write the plan

Keep it short. A plan is the set of decisions the builder cannot make alone: which files, which names, which values, and which checks prove each step. A plan longer than the code it describes has written the code instead.

Use this shape:

```markdown
# <Feature name>

**Goal:** one sentence on what this builds, in plain words.

## Phase 1: <name>
1. <task>: the file to create or change, the function or component and what it does.
2. <task> ...
3. Test: the test to add or the check to run, and what passing looks like.

## Phase 2: <name> (only if needed)
...

**What could go wrong:** the inputs or situations most likely to break this (empty, too large, invalid, the network being down), and which step handles each.
**Files this plan changes:** every existing file, including any the request did not mention.
```

Rules:

- **At most 3 phases, at most 3 tasks each.** If it needs more, plan the first part only and say what comes next.
- **Every phase ends with a test or a check** that a person can run.
- **Say what happens on failure** wherever the change touches input, files, the network, a database or payments.
- **Name every existing file you will change.** Call out any the request did not mention.
- **Mark guesses as guesses.** If you are assuming something about the code or the data, say "I am assuming ..." so the person can correct it.
- **For risky work** (data deletion, migrations, deploys, payments, auth): say what could be lost and exactly how to undo the change.
- No lines that decide nothing, such as "handle edge cases", "add validation" or "write tests". Say which case, which rule and which test.

## 3. Check the plan yourself

Read the request again with fresh eyes. Can you point to a task for every part of it? Does every phase end with a check? Are the names the same in every task? Fix gaps in place, then present the plan.

## 4. Present it

In plan mode, write the plan to the plan file and call ExitPlanMode. If plan mode is not available, post the plan and wait for the person to approve it before editing any file.
