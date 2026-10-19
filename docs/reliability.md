# Reliability changes: development status

This branch introduces version 2 evidence and selective recovery. It is not a release of the entire protected-execution roadmap.

| Roadmap stage | Implemented here | Remaining release work |
| --- | --- | --- |
| 1: honest outcomes and sensitive paths | Unknown outcomes, explicit verdicts, bounded follow-up, shared path policy, multi-file/move patch guards, raw-byte snapshots, legacy audit and purge | Live host denial tests on each advertised agent/OS/version |
| 2: independent checks | Separate captured copy, frozen existing tests/configuration/fixtures, baseline approval, report inventories/counts, source/dependency freshness, proposed tests, criteria identity, managed green checkpoints | Actual installed Jest/Vitest/pytest/Go integration runs; broader report fixtures and runner compatibility; no evidence cache is enabled |
| 3: protected supervisor | Ordinary host launcher/watcher, controlled Claude/Codex hook probe, fail-closed protected preflight | Operational `sbx` backend, sanitized guest launch, separately isolated verifier, effective boundary validation, credential/MCP policy, independent startup hook protocol, live isolation/recovery tests |
| 4: integration and undo | Three-way transaction engine, preview/conflicts, inverse transactions, undo/redo, observed write snapshots, refusal when ownership is ambiguous | Protected candidate production depends on stage 3; broader rename/mode/concurrency recovery tests |
| 5: acceptance and installation | Criteria guidance inside plans, matching Claude Code host approval callbacks bind criteria automatically, configured criteria tied to checks, manual attestations bound to an exact snapshot, installation previews/backups/atomic merges/ownership/version checks, historical versus live diagnostics | Equivalent approval observations on other hosts, protection of host approvals from a sandboxed agent, wider live host validation |

**Protected execution is unavailable.** `keel run codex --protected` and `keel run claude-code --protected` stop before agent launch. The current implementation does not create a Docker Sandbox, and finding `sbx` alone does not enable it. There is no fallback to ordinary execution. No Docker installation, sign-in, global policy change, remote service, or telemetry is performed.

Docker's current boundary is described in its [security model](https://docs.docker.com/ai/sandboxes/security/). Its [0.48 release notes](https://docs.docker.com/ai/sandboxes/release-notes/) document changed JSON schemas and launch behavior. Enabling this feature needs a version-pinned backend and real platform tests, not optimistic assumptions about CLI defaults.

## Commands

Run from the project folder (or use `node /path/to/keel/bin/keel.mjs`):

```text
keel verify --json
keel status --json
keel receipt --json
keel baseline approve --task <task-id>
keel baseline approve --task <task-id> --accept <displayed-hash>
keel acceptance approve --task <task-id> --criterion <criterion-id>
keel acceptance approve --task <task-id> --criterion <criterion-id> --accept <displayed-hash>
keel revert --session <session-id> --dry-run
keel revert --session <session-id>
keel revert undo --dry-run
keel revert undo
keel revert redo
keel audit
keel install cursor --dry-run
keel install cursor --version 0.6.1
keel doctor
keel doctor --json
keel doctor --live codex
keel run codex
```

`verify` exits 0 for `verified`, 1 for `failed`, and 2 for `not_verified` or an operational error. `status` and receipts show successful checks even when the task lacks complete evidence. Plain receipts recheck workspace freshness. Legacy records remain readable and cannot authorize a version 2 verified checkpoint.

`doctor` validates configuration; it does not run a host. `doctor --live` invokes the selected installed CLI with a controlled prompt in a disposable directory. It may use the account's normal model quota. The probe checks a harmless secret-shaped file guard and records the exact host version/platform. An inconclusive probe never gets a live-tested label. Ordinary `run` records hook observations and can identify some outages during structured tool activity; idle time is not evidence of an outage. Ordinary hooks and their observer have the user's privileges and provide best-effort protection.

`apply <session> --dry-run` uses the transaction engine only when a completed protected-session record exists. Such records are not produced by this branch's launcher; the command cannot currently integrate a real protected session.

## Structured checks

Global settings remain in `~/.keel/config.json`; project overrides remain under `projects[absoluteProjectPath]`. Prefer explicit checks for custom commands and monorepos:

```json
{
  "checks": [
    {
      "id": "unit",
      "executable": "node",
      "args": ["--test", "test/*.test.mjs"],
      "cwd": ".",
      "format": "node-events",
      "scope": "full",
      "outputDirs": []
    }
  ],
  "criteria": [
    { "id": "cart-total", "text": "Quantities contribute to the cart total.", "check": "unit" }
  ]
}
```

Formats are `node-events`, `node-tap`, `jest`, `vitest`, `pytest`, `junit`, and `go`. Automatic Node detection uses a Keel-managed native event reporter, which distinguishes suites and repeated names and omits test stdout. Older Node versions without the necessary native event fields remain unverified. `{report}` in an argument is replaced with a unique managed report path; pre-existing reports are removed before execution. `exit` is for explicitly configured non-test checks such as a compiler; it provides no test denominator. Each required suite has its own ID and pinned full scope. One suite cannot replace another.

Simple native package test scripts can be detected automatically. Shell chains, echoed commands, unsupported runners and unconfigured custom shell commands do not become verified evidence. Detected unsupported build scripts also keep the overall task unverified. Configure their executable and argument array explicitly.

Use project-relative source, test and configuration arguments. Explicit absolute paths, file URLs and paths escaping the captured workspace are refused; `{report}` is reserved for the managed report file. Native Node event evidence requires `node --test`; an eval command printing report-shaped text cannot substitute for the runner.

Existing tests, fixtures, snapshots, manifests, lockfiles and recognized runner configuration are frozen at task start. A separate copy of the starting state establishes the baseline inventory. Candidate source is checked against those frozen files; proposed new/changed tests are checked separately. Existing skips remain visible. Removed tests, new focus/skip controls, missing inventory entries and zero executed tests cannot produce green. Changes to trusted verification inputs require the displayed baseline approval. Approval hashes bind the file diff, configuration, criteria and exact proposed tree.

Manual criteria use `manual: true` and reviewable `text`; they may also name a required `check`. The acceptance command displays the criterion and changes for review before recording approval. The approval becomes stale after changes to the source tree, dependencies, baseline or criteria. Ordinary mode cannot authenticate a human versus another process with the same user privileges; protected host approval remains stage 3 work.

Claude Code plans may use the acceptance section in `skills/plan/SKILL.md`: `- [id] Observable outcome. (check: suite-id)` or `(manual: named review)`. Keel stages only hashes before approval and binds the criterion text after a successful matching `ExitPlanMode` callback for the unchanged plan. Failed or unmatched approvals and plan changes cannot confirm criteria. This approval never approves changed tests or verification commands. A configured criterion cannot be replaced by conflicting plan text. Other hosts retain explicit configured criteria until their approval observations are implemented and live-validated.

Checks use one 120-second cycle budget by default, including initial inventory discovery and proposed checks. Completion gets one automatic cycle and at most one send-back. Further changes need explicit `keel verify` for fresh evidence. No result cache is currently used.

Source is captured as raw bytes; Git attributes and timestamps do not establish freshness. The captured copy and current workspace are compared by content after checks. Tests may write only to declared output directories; writes to source, dependencies, sensitive paths or undeclared locations inside the copy invalidate evidence. Node dependencies are privately copied and hashed; external dependency links require a configured verifier environment. Python distribution identity requires an installed interpreter with usable isolated metadata and hashes its installed distribution files. Go automatic verification disables module downloads; projects needing external modules require additional verifier-environment work. These environment failures remain visible.

Checks in ordinary mode still execute project code with the host user's permissions. A private copy and reduced environment are not an operating-system sandbox. Network/process confinement and tamper-resistant authoritative policy are unfinished stage 3 work.

## Sensitive paths and old stores

Guards, checkpoints and exports share `src/policy.mjs`. Ignore-file negations cannot override exclusions. Captures reject external links and omit known secret names/directories. This is a path policy, not a claim that arbitrary source files cannot contain inline secrets. Snapshots also exclude dependency/build/cache folders and project Git history.

Old stores are audited by object and index paths without printing file contents. Affected stores receive a quarantine record. Excluded index entries are removed; old blobs remain until explicitly purged. Restoring an entire old tree is disabled. Exports of trees with excluded paths are refused.

Run `keel audit` to review paths. To delete **all checkpoint recovery history** for a quarantined project, run:

```text
keel audit --purge-quarantined --confirm-project <displayed-project-id>
```

The first call without a matching confirmation prints the project ID and consequences. Session logs remain; their old checkpoint references become unavailable. Purging this checkpoint store does not promise forensic erasure from filesystem backups or other copies.

## Recovery boundaries

Keel never auto-commits, stashes or resets the user's repository. Transactions preserve their exact before/after bytes in Keel's store. Three-way merge preserves later unrelated text edits; overlaps, ambiguous deletions/additions, binary overlaps, links and unsupported mode changes stop before project writes. Undo and redo are new inverse transactions and may themselves conflict. Interrupted writes retain a transaction journal for recovery review.

Ordinary selective undo requires before/after observations and consistent session ownership. Post-only events, unobserved changes and overlapping sessions cannot authorize automatic recovery. When safe endpoints exist, refusal includes a review-only recovery patch in Keel's store; it can include unowned work and is never automatically applied. A project checkpoint does not recover databases, cloud services, deployment state or other external resources.

Shell writes retain before/after evidence, but timing alone does not establish exclusive ownership. They require recovery review. File-tool observations also become ambiguous if other paths changed during the operation.

No verdict proves general correctness, requirement correctness, native Windows/macOS behavior, CI success or production readiness. The future protected environment is Linux and will retain those boundaries.
