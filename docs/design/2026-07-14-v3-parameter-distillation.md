# Workflow v3 parameter distillation

Status: implemented behind the explicit `--distill` entry point; dogfood is
required before any natural-language or default-on entry is enabled.

## Problem

Saved Workflow currently performs an exact save. A successful ad-hoc run is
reusable, but every concrete literal remains frozen in the definition and the
result has no parameters. A model can suggest which literals should become
parameters, but model output cannot be allowed to mutate or publish an
executable definition directly.

The distillation feature therefore produces a reviewable revision proposal.
The host validates and compiles the proposal against immutable source-run
artifacts; an authenticated user then accepts or rejects the exact diff.

## Product contract

The initial entry point is explicit:

```text
/workflow save last Weekly report --distill
```

Natural-language equivalents remain disabled until dogfood; if enabled later,
they must still pass the existing Workflow intent confirmation. Exact save
remains unchanged.

The first release is intentionally narrow:

- only a successful, authenticated ad-hoc run can be distilled;
- an explicit display name is required and goes through reusable-text lint;
- it creates a new chat-scoped Saved Workflow;
- every proposed parameter is required and has no stored default;
- only goal/instruction text and matching narrative-spec text may change;
- the user accepts the entire deterministic diff or rejects it;
- no definition is created before acceptance.

Global publication, appending to an existing definition, partial candidate
editing, host-input parameterization, non-string types, stored defaults, and sensitive parameters
are follow-ups. In particular, the distiller never chooses owner, scope, app,
chat, publication status, or workflow identity.

## Trust boundaries

There are three distinct objects:

1. **Source run** — immutable `run.json` plus digest-pinned DAG, spec, and bot
   snapshots. It is the only source of execution truth.
2. **Model suggestion** — untrusted structured output from a no-tool model
   call. It can select candidate literals and locations, but cannot name
   parameters and has no authority to write the library.
3. **Host proposal** — a normalized, content-addressed patch compiled by the
   host from the source run and suggestion. Only this object is shown for
   approval and later committed.

P0 uses Claude Code's non-interactive structured-output surface directly; it
does not reuse the general Workflow goal worker. The subprocess runs with
`--bare` and safe mode, no skills/plugins/MCP/session persistence, and an empty
built-in tool set. Its HOME, cwd, TMPDIR, and every config root point at one
fresh `0700` scratch directory; no user OAuth/keychain/config state is copied.
The child environment is rebuilt from a narrow, documented direct-credential
allowlist: Anthropic API key, Bedrock static key pair or bearer token plus
region, or Foundry API key plus resource/base URL. Vertex ADC, OAuth/bearer-only
Claude sessions, credential files/profiles/helpers, wrapper launchers, and
machine-identity fallback all fail closed in P0. Botmux/Lark/session variables
are never inherited.

The classifier additionally runs inside a dedicated Linux bubblewrap boundary:
the host root and a frozen `/etc` snapshot are read-only, scratch is the only
writable host bind, network remains available for the selected provider, and a
new PID namespace plus `--die-with-parent` collapses descendants before scratch
cleanup. Endpoint-managed Claude policy is excluded from the frozen child view;
if such policy is already active, the runner refuses to start instead of
claiming a no-side-effect boundary it cannot prove.
Only the minimized allowlisted execution-text field array is written to stdin;
the process receives no transcript, result file, library path, source-run path,
or workspace path. The provider/model is trusted with this explicitly
authorized text, while the returned structure remains untrusted. Raw stdout is
bounded, retained only in memory, and discarded after host validation; scratch
cleanup is a mandatory success condition. Before classifier execution is
released, the host durably pins both the bubblewrap monitor and PID-namespace
init identities. Normal completion, timeout, and startup recovery wait for both
exact identities to disappear before removing scratch. Corrupt/future markers
and pre-spawn directories without ownership proof are retained for inspection;
only old markerless directories are age-cleaned. Other CLIs and wrapper launchers fail loud until
they provide an equivalent mechanically no-tool structured-call contract.

## Allowed transformation

P0 allows replacements only in these execution-text paths, including the same
paths inside a structured-loop body:

- `dagTemplate.nodes[*].goal`
- `dagTemplate.nodes[*].override.systemPromptAppend`

Everything else is immutable: topology, node and loop IDs, bot selectors,
dependencies, inputs, gates, result schemas, loop control, executor types,
host inputs, timeout/concurrency fields, and safety metadata.

For every selected source literal, the host also replaces every exact
occurrence in the narrative `specTemplate` string fields: title, requirement,
top-level acceptance/non-goals, and each node sketch's goal, input needs,
expected outputs, acceptance, and unknowns. The model cannot freely rewrite
the spec. If the selected literal appears in any non-allowlisted revision or
metadata field, P0 rejects the candidate instead of leaving a concrete value
behind.

Each suggestion identifies an allowlisted JSON pointer, an exact source
literal, an occurrence index, and a scalar type. The host resolves the literal
against the pinned baseline, rejects ambiguous or overlapping spans, sorts the
candidates canonically, and assigns deterministic generic names (`param_1`,
`param_2`, ...). Identical literals intentionally share a parameter. The host
then canonicalizes each replacement to:

```ts
interface DistilledReplacementV1 {
  path: string;
  startUtf8: number;
  endUtf8: number;
  literalSha256: string;
  replacement: `\${params.${string}}`;
}
```

The durable host proposal stores the source span and hash, not another clear
text copy of the literal. Applying replacements from the end of each string
keeps offsets deterministic. Recomputing the literal hash and the complete
baseline revision hash is mandatory at approval time.

P0 generates only required `string` parameters. Number, boolean, object, and
array parameters remain valid in hand-authored definitions but need a
structured input/editing surface before automatic inference is safe. All
generated host-owned parameter names must pass the existing Saved Workflow
name validator and reserved-name checks.

The final revision goes back through the normal host-owned validators:

- `validateDagTemplate`;
- `assertSavedWorkflowTemplateBindings`;
- a matching spec-marker validator;
- `validateSavedWorkflowRevisionPayload`;
- reusable-text secret/path lint;
- frozen bot-snapshot and safety-digest checks.

The compiler then substitutes each marker with its source example value in
memory. The resulting DAG and spec must be byte-for-byte/canonically equal to
the pinned baseline on every allowlisted field, while all structural fields
remain identical. This reverse-fill test proves that P0 performed abstraction,
not semantic editing. A proposal that cannot prove the round trip is rejected;
an accepted P0 revision therefore keeps `specStatus: "current"`.

## Context and sensitive values

Authenticated chat identity is never an ordinary parameter. The supported
built-in context references remain:

- `context.chatId`
- `context.larkAppId`
- `context.chatType`
- `context.rootMessageId`
- `context.initiatorOpenId`

The model cannot invent a context reference. P0 only preserves refs already
present in the source definition; deterministic inference of new refs from an
exact source binding is a follow-up. Host executor identity fields are outside
the P0 transformation allowlist and retain the existing exact-context binding
requirements.

Secret-looking literals are not converted into normal parameters. The current
runtime deliberately refuses executable `sensitive: true` parameters because
resolved values would enter immutable run artifacts. Distillation must return
an actionable blocked result instead: move the value to a bot-managed
credential or remove it before saving.

Machine-local absolute paths, network locators, explicit platform identities,
emails, and secret-looking values are rejected in P0 rather than converted. No
proposal or card stores a default value or model-authored metadata; parameter
names are generic host-owned identifiers. Free-form person-name inference is
not treated as a reliable security boundary: the model is instructed not to
select it, while cards and durable proposal metadata never render or default
any selected source value.

## Proposal and approval

The host proposal is bound to:

- source run ID;
- source `run.json` digest and pinned artifact digests;
- canonical baseline revision hash;
- authenticated owner open ID, Lark app ID, and chat ID;
- compiler version;
- normalized parameter definitions and replacements;
- proposal hash and creation time.

The review card contains no raw literal values. It shows parameter name, type,
required/no-default status, replacement count, and safe node-ordinal/field
categories (not raw node IDs or JSON pointers).
Literal hashes stay inside the `0600` host proposal because even a truncated
hash can be a dictionary oracle for a low-entropy name or project label. The
card states that the DAG/spec round trip was verified and structural/safety
fields did not change.
The only P0 actions are **Save to this chat** and **Reject**.

The card value contains the proposal ID and a nonce derived from the immutable
proposal hash. A click is accepted only when the operator is the source-run
owner, the receiving app/chat matches, and the source/proposal still validate.
Approval is not transferable across apps or chats.

## Durable state machine

Proposal state lives under a private host-owned directory, mode `0700`, with
files mode `0600`:

```text
prepared -> proposed -> accepted -> committing -> committed
                    \-> rejected
                    \-> superseded
```

- `prepared` records source identity before the worker starts.
- `proposed` publishes one immutable normalized proposal.
- `accepted` records the authenticated approval for that proposal hash.
- `committing` allocates the final workflow ID before touching the library.
- `committed` records the exact workflow/revision IDs.

Every transition is lock-protected, compare-and-swap, atomic-write plus fsync,
and idempotent. Recovery never asks the model to regenerate an existing
proposal. If the process crashes after library publication but before the last
transition, recovery loads the allocated workflow ID, verifies the byte-exact
revision, and completes `committed`; a mismatch fails closed.
Accepted/committing transitions recover in a global startup pass and therefore
do not depend on the source Bot still being configured. Prepared/proposed card
delivery and new model generation remain scoped to the matching configured Bot.

Only one live proposal may exist for the same `(source artifact digests,
owner, app, chat, compiler version)`. Starting a replacement first marks the
old proposal `superseded`, preserving its audit record.

## Compiler output

The compiler creates an ordinary existing-schema `SavedWorkflowRevisionDraft`:

- `inputs` contains only accepted, validated, required parameters;
- `contextRefs` contains deterministic built-in references;
- `dagTemplate` contains only allowlisted marker replacements;
- `specTemplate` contains only the same exact marker replacements as its
  allowlisted source text;
- `specStatus` remains `current` after the reverse-fill equivalence proof;
- `safety` is recomputed from the normalized DAG;
- `sourceRunId` retains provenance.

No revision-schema migration is required. Materialization and execution keep
the existing behavior: markers remain in the goal and each node receives only
the referenced parameter/context subset through the untrusted workflow-input
JSON file.

## Failure behavior

All unsafe or ambiguous cases fail before library publication with stable
reason codes, including:

- source run not successful, owned, or digest-valid;
- unsupported path or structural mutation;
- missing/ambiguous literal occurrence or overlapping spans;
- malformed or duplicate model candidate;
- parameter marker already present with incompatible declaration;
- source-value residue in metadata, structural fields, or unpatched spec text;
- secret-like value or leaked identity/path in generated metadata;
- source/proposal changed between review and approval;
- cross-app/chat approval or stale nonce;
- model timeout, malformed structured output, or zero usable candidates.

Errors rendered to chat contain reason classes and safe ordinal field labels
only, never the source literal, raw node ID/path, or model raw output.

## Dogfood and rollout

The feature stays behind explicit `--distill` until dogfood demonstrates:

- proposal quality on at least ten different successful workflows;
- no topology, gate, bot, host-input, or scope drift;
- deterministic replay across daemon restart and duplicate card delivery;
- cross-app/chat list, lookup, approval, and materialization denial;
- secret/path/person-like values never appearing in cards, logs, telemetry, or
  committed defaults;
- reverse-filling every proposal with its source values reproduces both the
  source DAG and spec exactly;
- accepted definitions rerun with different values and preserve output
  contracts;
- reject, timeout, crash-before-proposal, crash-before-commit, and
  crash-after-library-publication recovery.

Telemetry is aggregate only: reason code, candidate/replacement counts,
latency, accepted/rejected outcome, and compiler version. It must not include
goals, parameter values, names, descriptions, paths, run IDs, workflow IDs, or
user identifiers.

## Non-goals

- automatically saving every successful run;
- automatic global publication;
- storing concrete values as defaults;
- parameterizing host side effects or human-gate prompts;
- using model output as an executable revision;
- rewriting a source run or an existing immutable revision;
- solving definition-as-code import/export or node-result caching.
