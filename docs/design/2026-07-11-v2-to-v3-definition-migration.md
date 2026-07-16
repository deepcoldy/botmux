# v2 definition → v3 Saved Workflow migration

## Scope

This is the migration-window bridge, not a second runtime. It converts only a
provably equivalent subset of legacy definitions into immutable v3 Saved
Workflow revisions. Unsupported semantics are reported with stable field-level
codes; the converter never guesses.

The legacy JSON file is read-only source material. Migration state lives under
`<dataDir>/workflow-migrations/v2-to-v3.json`; v3 definitions live under the
existing `<dataDir>/workflow-library/` store.

## Identity and versioning

- Source identity: `realpath(definition) + workflowId`.
- Source revision: canonical legacy `computeRevisionId(definition)`.
- One source identity owns one deterministic `wf_<hash>` target.
- Each new source revision appends (or, if the converted bytes are identical,
  reuses) an immutable v3 revision on that target.
- The ledger maps every source revision to its exact v3 `revisionId` and keeps
  the conversion hash, owner, scope, allocation time, and expected prior
  revision needed for recovery.

A source edit after its first migration does **not** re-enable v2. The new hash
is fail-closed until it is migrated as the next v3 revision.
Likewise, a copied/moved/symlink-retargeted file cannot evade the exact path
key: the execution guard falls back to any ledger source with the same
`workflowId` and requires the new path to be migrated explicitly.

## Two-phase commit

Per source, a cross-process lock serializes conversion:

1. Re-read and validate the source; build and normalize the v3 revision draft.
2. Precompute the exact target revision (`humanVersion`, `createdAt`,
   `revisionId`, expected latest revision).
3. Durably write a `pending` ledger record.
4. Create/append the v3 revision as a draft using the existing library
   transaction.
5. Re-read the source and require the same canonical hash.
6. Publish exactly the allocated latest revision.
7. Mark the ledger revision `committed`.

`pending` and `committed` both block v2 new-run paths. Therefore every crash
window is safe:

- before pending: no state changed;
- after pending: retry reconstructs the frozen allocation;
- after immutable revision/metadata: retry byte-checks and reuses it;
- after publish: retry only advances the ledger marker.

If an external library edit races the expected-latest guard, or the source is
edited after pending, migration stops fail-closed for operator resolution. It
never overwrites the external edit or falls back to v2.

## Conversion boundary

Automatically supported:

- goal/subagent DAGs with one sink;
- exact `larkAppId` bot selectors on the v3 CLI allowlist with bypass enabled;
- unconditional dependencies;
- string goals with declared top-level `${params.NAME}` markers;
- parameter type/required/default/description;
- model override, whole-second timeout, static pre-gate + approvers (goal
  timeouts are flagged because v2 did not enforce them, while v3 will);
- the strict flat v3 result schema subset;
- chat-scoped `feishu-send` (and eligible schedule) only when literal app/chat
  identity exactly equals the explicitly supplied migration target, allowing a
  lossless rewrite to authenticated `context.*` refs.

Fail-loud examples:

- output/previous interpolation or any whole-field `$ref`;
- nested/undeclared/malformed parameter markers or dynamic gate text;
- decision-terminated loops, multi-sink graphs;
- workingDir, toolPolicy, reasoningEffort, automatic retry, concurrency caps;
- unsupported CLI, name-based bot selector, restricted bot;
- ungated/foreign/dynamic host effects, fixed reply roots, schedule local
  delivery/stored parsed time;
- unsupported/nested JSON Schema keywords.

Inert retry/max-output/host-timeout declarations, behavior-corrected goal
timeouts, and stripped annotations are warnings. A commit containing warnings
requires `--ack-warnings`.

If a crash left a pending allocation that was never materialized and another
owner edit advanced the Saved Workflow meanwhile, recovery remains fail-closed
until the operator adds `--supersede-pending`. The old allocation is retained
in the ledger as immutable audit; committed or materialized allocations can
never be superseded.

## CLI and authorization

`botmux template migrate-v3` is dry-run by default and reports malformed and
shadowed assets instead of using the dashboard catalog's silent-skip behavior.

Commit requires explicit owner/app/scope; none is inferred from `bots[0]`, the
shell, or static environment identity. Chat scope additionally requires
chatId/chatType. Workflow subagents are denied the entire migration command by
the C0 root-command fence.

The shared legacy loader checks the ledger before creating a new v2 run, which
covers CLI, IM, dashboard, and connector triggers. Existing v2 run snapshots
remain resumable/cancellable during the drain window.

The migration writer, legacy execution guard, and bare CLI share one durable
dataDir resolver (`SESSION_DATA_DIR` → daemon breadcrumb → `~/.botmux/data`),
so a missing environment variable cannot split the write and deny paths.
Chat-scoped Saved Workflows are checked both at visible-resolution time and at
the low-level materialization boundary before authenticated `context.*` values
are frozen into a run.
