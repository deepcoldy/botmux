# LinkRef URL Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every registered model-visible source URL byte-for-byte through final delivery by replacing model-authored URL reconstruction with turn-bound LinkRef placeholders expanded by the trusted Botmux host.

**Architecture:** A daemon-owned SQLite `LinkRefLedger` binds immutable random refs to original URL strings under `(appId, sessionId, turnId, dispatchAttempt)`. Admission code and trusted result bridges extract/register URLs and append a companion block, while CLI sends, automatic finals, sandbox relays, and Remote Runner output resolve refs through one host-side resolver before rendering, validation, fingerprinting, uploads, or network effects. The effective `disabled | observe | enabled` mode is frozen at turn admission and transported as trusted turn metadata; `disabled` never constructs the ledger or enters extraction/resolution paths.

**Tech Stack:** TypeScript, Bun 1.4.3, Vitest 4, Node/Bun SQLite compatibility layer, daemon/worker IPC, MCP SDK, Markdown-aware lexical scanning.

**Spec:** `docs/superpowers/specs/2026-10-19-link-ref-url-integrity-design.md`

## Global Constraints

- The LinkRef spelling is exactly `{{botmux_link:lr_<32 lowercase hex characters>}}`.
- `originalUrl` is the exact UTF-8 substring cut from the source; URL parsers may validate it but must never supply the persisted or expanded value.
- `originalUrl` may be shown to the model only in its own source-scoped companion block; it is never copied into a hidden global prompt, log, metric, error, or diagnostic.
- Identity is exactly `appId + sessionId + turnId + dispatchAttempt`; missing `dispatchAttempt` is stored as the canonical attempt `0` and is never equal to a positive attempt.
- A turn may register at most 128 distinct URLs, each at most 8 KiB, with at most 512 KiB total original URL bytes.
- Settled turns are retained for 7 days; open turns inactive for 7 days expire and are removed.
- The LinkRef database is daemon-owned: no protocol exposes its path or mappings, sandbox/scratch processes receive an explicit filesystem deny, and Remote Runner providers never receive it. A non-sandbox CLI sharing the daemon's OS uid remains inside the host trust boundary described by the spec and is not claimed to be OS-isolated.
- `disabled` is the default and must not scan, open/create/query the ledger, inject a companion block, parse outbound placeholders, or add IPC/database work.
- `observe` scans and emits only redacted counters/timings; it creates no turn/link rows and changes no model-visible or user-visible content.
- A mode is frozen once at turn admission. Configuration changes affect only later turns; an already-enabled turn remains resolvable even after an emergency disable.
- Registration failure is fail-open for the original model-visible result: return the unmodified source and omit only the unavailable refs.
- Expansion failure is fail-closed before rendering, `--expected-link`, fingerprints, contact lookup, attachment upload, TTS, hooks, or platform/network calls.
- Ordinary URLs, including intentional base URLs, are never supplemented, replaced, or rejected merely because another registered URL shares their origin/path.
- Bearer/Basic/auth headers, cookies, passwords, secrets, private keys, API keys, and access/refresh/id/session token leaves are never registered or logged.
- User-action authorization URLs remain registerable even when their query includes `code`, `token`, `signature`, `state`, or `redirect_uri`.
- Code fences, inline code, escaped `\{{botmux_link:...}}`, and malformed lookalikes remain literal; the escape backslash alone is removed on delivery.
- No raw URL, authorization query, filtered credential value, or full companion block may enter normal logs, metrics, or diagnostics.
- Do not run `bun install` in the implementation worktree; canonical dependencies are shared.
- Every implementation task follows RED → minimal GREEN → focused regression → commit, with commit messages in `type(scope): 中文描述` form.

---

## File structure and locked interfaces

New modules are responsibility-focused; adapters call them rather than growing parallel URL logic:

- `src/services/link-ref-types.ts` — public LinkRef modes, identity, sources, records, error codes, limits, and result contracts.
- `src/services/link-ref-config.ts` — strict configuration normalization and admission-time effective-mode resolution.
- `src/services/link-ref-extractor.ts` — exact text spans, structured-leaf traversal, credential filtering, metadata exclusion, and redacted scan statistics.
- `src/services/link-ref-ledger.ts` — daemon-only SQLite schema, immutable batch registration/resolution, draft persistence, settlement, expiry, and session cleanup.
- `src/services/link-ref-presenter.ts` — deterministic companion text and MCP/resource companion content without mutating original results.
- `src/services/link-ref-resolver.ts` — Markdown-aware placeholder tokenizer and recursive outbound text/card expansion.
- `src/services/link-ref-runtime.ts` — lightweight daemon singleton combining extraction, presentation, diagnostics, and resolution while lazily opening the ledger only for enabled work; disabled turns never invoke it and observe turns never call `ledger()`.
- `src/core/link-ref-turn.ts` — admission-time source collection, attachment text bounding, mode freeze, initial ledger registration, and `CliTurnPayload` decoration.
- `src/core/link-ref-ipc.ts` — bounded daemon/worker and session-CLI broker DTO validation; callers never receive a ledger path.

The following exact contracts are shared across tasks:

```ts
export type LinkRefMode = 'disabled' | 'observe' | 'enabled';

export interface LinkRefConfig {
  mode?: LinkRefMode;
}

export interface LinkRefTurnKey {
  appId: string;
  sessionId: string;
  turnId: string;
  dispatchAttempt?: number;
}

export interface LinkRefTurnRecord extends Required<LinkRefTurnKey> {
  mode: 'enabled';
  state: 'open' | 'settled' | 'expired';
  createdAtMs: number;
  lastActivityAtMs: number;
  settledAtMs?: number;
  expiresAtMs: number;
}

export type LinkRefSourceType =
  | 'user_message' | 'group_context' | 'card' | 'history' | 'quoted'
  | 'attachment' | 'tool' | 'mcp' | 'public_system_doc';

export type LinkRefSourceInput =
  | { sourceType: LinkRefSourceType; kind: 'text'; text: string; sourceId?: string }
  | { sourceType: 'attachment'; kind: 'attachment_text'; path: string; sourceId?: string }
  | { sourceType: LinkRefSourceType; kind: 'structured'; value: unknown; sourceId?: string };

export interface LinkRefCandidate {
  originalUrl: string;
  sourceType: LinkRefSourceType;
  sourceId?: string;
}

export interface RegisteredLinkRef {
  refId: `lr_${string}`;
  originalUrl: string;
  sourceType: LinkRefSourceType;
  sourceId?: string;
}

export interface LinkRefExtractionStats {
  scannedBytes: number;
  found: number;
  candidateCount: number;
  filteredCredential: number;
  filteredMetadata: number;
  filteredInvalid: number;
}

export interface LinkRefExtractionResult {
  candidates: LinkRefCandidate[];
  stats: LinkRefExtractionStats;
}

export interface LinkRefDiagnostic {
  mode?: LinkRefMode;
  sourceType?: LinkRefSourceType;
  scannedBytes?: number;
  found?: number;
  registered?: number;
  deduplicated?: number;
  filtered?: number;
  limited?: number;
  refId?: string;
  urlHash?: string;
  outcome?: string;
  errorCode?: string;
  refCount?: number;
  durationMs?: number;
}

export type LinkRefLedgerErrorCode =
  | 'link_ref_turn_missing'
  | 'link_ref_turn_not_open'
  | 'link_ref_unknown'
  | 'link_ref_identity_mismatch'
  | 'link_ref_expired'
  | 'link_ref_limit_exceeded'
  | 'link_ref_ledger_unavailable';

export type OutboundLinkRefErrorCode =
  | LinkRefLedgerErrorCode
  | 'expected_link_invalid_after_link_ref';

export interface LinkRefRegistrationResult {
  registered: RegisteredLinkRef[];
  deduplicated: number;
  filteredByLimit: number;
  failure?: LinkRefLedgerErrorCode;
}

export class LinkRefError extends Error {
  readonly code: OutboundLinkRefErrorCode;
  constructor(code: OutboundLinkRefErrorCode, message: string = code) {
    super(message);
    this.name = 'LinkRefError';
    this.code = code;
  }
}

export interface LinkRefTurnEnvelope {
  mode: LinkRefMode;
  sources?: LinkRefSourceInput[];
}
```

`LinkRefRegistrationResult.registered` contains one entry for every byte-distinct accepted URL requested by the batch, including an existing immutable mapping reused from an earlier batch in the same turn. `deduplicated` counts repeated candidates/mapping reuses; callers can therefore always build the current result's companion without a second lookup.

`CliTurnPayload` gains daemon-only `linkRefs?: LinkRefTurnEnvelope`. Before any payload crosses daemon→worker IPC, `prepareLinkRefTurnPayload(...)` removes `sources`, freezes `mode`, registers the candidates when enabled, and appends the companion to both legacy `content` and Codex App additional context through `addCodexAppContext(..., 'botmux_link_refs', companion, 'untrusted')`; long blocks therefore use the repository's fixed-width chunk keys and preserve order without rewriting `codexAppInput.text`. `DaemonToWorker.init/message`, pending input records, active turn identity, worker finals, sandbox origin capabilities, and Remote Runner host context carry only `linkRefMode?: 'observe' | 'enabled'`; absence is the byte-compatible disabled representation.

`BOTMUX_LINK_REFS_MODE` is reserved for daemon-side administrator configuration and is removed from worker/CLI child environments after admission. When a host re-exec needs an environment hint, it uses the separate `BOTMUX_LINK_REF_TURN_MODE`; caller-provided values are scrubbed, and the daemon still derives the authoritative mode and identity from authenticated live state. This hint may cause a resolve attempt but may never downgrade a trusted marker/capability that says `enabled`.

The daemon-owned store API is fixed as:

```ts
export class LinkRefLedger {
  constructor(dataDir: string, options?: { now?: () => number; randomBytes?: (size: number) => Buffer });
  openTurn(key: LinkRefTurnKey): void;
  readTurn(key: LinkRefTurnKey): LinkRefTurnRecord | undefined;
  registerBatch(key: LinkRefTurnKey, candidates: readonly LinkRefCandidate[]): LinkRefRegistrationResult;
  resolveBatch(key: LinkRefTurnKey, refIds: readonly string[]): Map<string, string>;
  savePendingDraft(key: LinkRefTurnKey, content: string): void;
  readPendingDraft(key: LinkRefTurnKey): string | undefined;
  clearPendingDraft(key: LinkRefTurnKey): void;
  settleTurn(key: LinkRefTurnKey): void;
  settleOpenSessionTurns(appId: string, sessionId: string): number;
  deleteSession(appId: string, sessionId: string): number;
  pruneExpired(nowMs?: number): { expired: number; removed: number };
  close(): void;
}
```

The only outward resolver contract is:

```ts
export interface OutboundLinkRefPayload {
  text?: string;
  preparedText?: string;
  card?: Record<string, unknown>;
  expectedLinks?: string[];
}

export interface ResolvedOutboundLinkRefs extends OutboundLinkRefPayload {
  refCount: number;
}

export function resolveOutboundLinkRefs(
  ledger: LinkRefLedger,
  key: LinkRefTurnKey,
  payload: OutboundLinkRefPayload,
): ResolvedOutboundLinkRefs;
```

The runtime contract used by admission, brokers, and final delivery is:

```ts
export interface LinkRefRuntime {
  prepareTurn(input: {
    key: LinkRefTurnKey;
    mode: LinkRefMode;
    payload: CliTurnPayload;
  }): CliTurnPayload;
  registerSources(input: {
    key: LinkRefTurnKey;
    mode: 'observe' | 'enabled';
    sources: readonly LinkRefSourceInput[];
  }): { companion?: string; stats: LinkRefExtractionStats };
  resolveForDaemon(
    key: LinkRefTurnKey,
    mode: LinkRefMode,
    payload: OutboundLinkRefPayload,
  ): ResolvedOutboundLinkRefs;
  restoreMode(key: LinkRefTurnKey): 'enabled' | undefined;
  settleTurn(key: LinkRefTurnKey): void;
  deleteSession(appId: string, sessionId: string): number;
  pruneExpired(nowMs?: number): { expired: number; removed: number };
  recordDiagnostic(event: LinkRefDiagnostic): void;
  close(): void;
}
```

`prepareLinkRefTurnPayload(...)` delegates to `LinkRefRuntime.prepareTurn`. `restoreMode` is called only after session/turn recovery has independently proven that the exact turn is active/recoverable; it performs only `readTurn(exactKey)` and returns `enabled` only for an unexpired `open` row. Final retry draft resolution uses the explicit frozen mode plus the settled row instead. It never enumerates rows or consults current configuration.

All daemon/CLI broker handlers derive `appId`, `sessionId`, `turnId`, `dispatchAttempt`, and frozen mode from authenticated live state. Request bodies may contain source/result text or outbound payloads but never identity overrides or a caller-supplied `ref → URL` mapping. On daemon/worker recovery, `readTurn(exactKey)` is the durable source that can restore an already-enabled turn even if configuration is now disabled; it is never used to infer identity or search by partial keys.

### Task 1: Normalize configuration and freeze the effective turn mode

**Files:**
- Create: `src/services/link-ref-types.ts`
- Create: `src/services/link-ref-config.ts`
- Modify: `src/global-config.ts`
- Modify: `src/bot-registry.ts`
- Modify: `src/types.ts`
- Test: `test/link-ref-config.test.ts`
- Test: `test/bot-registry-link-ref.test.ts`

**Interfaces:**
- Produces: `LinkRefMode`, `LinkRefConfig`, `LinkRefTurnKey`, source/result types, and constants in the locked interface section.
- Produces: `normalizeLinkRefConfig(raw): LinkRefConfig | undefined`.
- Produces: `resolveEffectiveLinkRefMode(input: { env: NodeJS.ProcessEnv; bot?: LinkRefConfig; global?: LinkRefConfig }): LinkRefMode`.
- Produces: optional `GlobalConfig.linkRefs`, `BotConfig.linkRefs`, and `CliTurnPayload.linkRefs`.
- Consumed by every later task; no later task reads live configuration after admission.

- [ ] **Step 1: Write failing mode precedence/default tests**

Create `test/link-ref-config.test.ts` with table-driven assertions:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeLinkRefConfig, resolveEffectiveLinkRefMode } from '../src/services/link-ref-config.js';

describe('LinkRef config', () => {
  it.each([
    [{}, 'disabled'],
    [{ global: { mode: 'observe' } }, 'observe'],
    [{ global: { mode: 'enabled' }, bot: { mode: 'disabled' } }, 'disabled'],
    [{ global: { mode: 'disabled' }, bot: { mode: 'observe' } }, 'observe'],
    [{ global: { mode: 'enabled' }, bot: { mode: 'observe' }, env: { BOTMUX_LINK_REFS_MODE: 'disabled' } }, 'disabled'],
    [{ global: { mode: 'disabled' }, bot: { mode: 'observe' }, env: { BOTMUX_LINK_REFS_MODE: 'enabled' } }, 'enabled'],
  ])('resolves %j to %s', (input, expected) => {
    expect(resolveEffectiveLinkRefMode({ env: {}, ...input })).toBe(expected);
  });

  it('drops malformed modes instead of enabling them', () => {
    expect(normalizeLinkRefConfig({ mode: 'strict' })).toBeUndefined();
    expect(normalizeLinkRefConfig({ mode: true })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `bunx vitest run test/link-ref-config.test.ts`

Expected: FAIL because both the module and types are absent.

- [ ] **Step 3: Write failing global/per-Bot parser tests**

Create `test/bot-registry-link-ref.test.ts`; isolate HOME for global config and parse four Bot entries. Assert exact valid values survive, missing/invalid values become `undefined`, and no mode defaults to `enabled` in persisted config.

```ts
expect(parseBotConfigsFromText(JSON.stringify([
  base('off', { linkRefs: { mode: 'disabled' } }),
  base('observe', { linkRefs: { mode: 'observe' } }),
  base('on', { linkRefs: { mode: 'enabled' } }),
  base('bad', { linkRefs: { mode: 'strict' } }),
])).map(x => x.linkRefs?.mode)).toEqual(['disabled', 'observe', 'enabled', undefined]);
```

- [ ] **Step 4: Run parser tests and verify RED**

Run: `bunx vitest run test/bot-registry-link-ref.test.ts`

Expected: FAIL because `GlobalConfig`/`BotConfig` do not expose or normalize `linkRefs`.

- [ ] **Step 5: Implement the type/config surface**

Add the locked types and these exact constants to `link-ref-types.ts`:

```ts
export const LINK_REF_MAX_URLS_PER_TURN = 128;
export const LINK_REF_MAX_URL_BYTES = 8 * 1024;
export const LINK_REF_MAX_TOTAL_URL_BYTES = 512 * 1024;
export const LINK_REF_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const LINK_REF_ENV_MODE = 'BOTMUX_LINK_REFS_MODE';
```

Implement `normalizeLinkRefConfig` using exact string equality and `resolveEffectiveLinkRefMode` in the precedence `env → bot → global → disabled`; invalid env values are ignored with the lower layer retained. Wire the same normalizer into `readGlobalConfig()` and `parseBotConfigsFromText()`. Add `linkRefs?: LinkRefTurnEnvelope` to `CliTurnPayload` only; do not add it to persisted `Session`.

- [ ] **Step 6: Run focused tests and build**

Run: `bunx vitest run test/link-ref-config.test.ts test/bot-registry-link-ref.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/services/link-ref-types.ts src/services/link-ref-config.ts src/global-config.ts \
  src/bot-registry.ts src/types.ts test/link-ref-config.test.ts test/bot-registry-link-ref.test.ts
git commit -m "feat(link-ref): 增加灰度配置与轮次模式类型"
```

### Task 2: Extract exact URLs and filter only credential leaves

**Files:**
- Create: `src/services/link-ref-extractor.ts`
- Test: `test/link-ref-extractor.test.ts`
- Test: `test/link-ref-sensitive-fields.test.ts`

**Interfaces:**
- Consumes: `LinkRefCandidate`, `LinkRefSourceInput`, `LinkRefSourceType` from Task 1.
- Produces: `extractHttpUrlSpans(text: string): Array<{ start: number; end: number; originalUrl: string }>`.
- Produces: `collectLinkRefCandidates(sources: readonly LinkRefSourceInput[]): LinkRefExtractionResult`.
- Produces: redacted `LinkRefExtractionStats` containing byte/count/filter categories but no URL strings except in the private candidate list.
- Consumed by admission, CLI broker, MCP bridge, and observe-mode diagnostics.

- [ ] **Step 1: Write failing exact-span tests**

Cover raw URLs, Markdown destinations, angle brackets, balanced parentheses, Chinese/English trailing punctuation, repeated/empty query parameters, fragments, case, Unicode, and percent encoding. The central assertion must compare exact source slices:

```ts
const source = '参见（https://A.test/p(a)#Frag），然后继续。';
const [span] = extractHttpUrlSpans(source);
expect(span.originalUrl).toBe('https://A.test/p(a)#Frag');
expect(source.slice(span.start, span.end)).toBe(span.originalUrl);
```

Include negatives for `ftp:`, relative paths, malformed hosts, and `https://user:password@example.test/p`.

- [ ] **Step 2: Run exact-span tests and verify RED**

Run: `bunx vitest run test/link-ref-extractor.test.ts`

Expected: FAIL because the extractor does not exist.

- [ ] **Step 3: Write failing structured filtering tests**

Build one nested object containing:

```ts
{
  headers: { Authorization: 'Bearer secret', Cookie: 'sid=secret' },
  password: 'https://should-not-register.test/',
  access_token: 'https://should-not-register.test/access',
  authorization: {
    url: 'https://auth.test/approve',
  },
  authorization_url: 'https://auth.test/login',
  documentation_url: 'https://docs.test/page',
  nested: { _meta: { 'botmux/linkRefPolicy': 'exclude' }, url: 'https://excluded.test/x' },
}
```

Assert only the three user-action/documentation URLs register; exact field matching must not filter `documentation_url` or `token_help_url`. Add Bearer/Basic string-shape cases, header-case variants, hyphen/underscore equivalence, text content blocks, text resources, and binary blobs that remain unscanned.

- [ ] **Step 4: Run filtering tests and verify RED**

Run: `bunx vitest run test/link-ref-sensitive-fields.test.ts`

Expected: FAIL because structured traversal/filtering is absent.

- [ ] **Step 5: Implement the minimal scanner and structured walker**

Use a linear `http://|https://` candidate scan, trim only syntactically external punctuation, track balanced `()[]{}` inside the candidate, validate via `new URL(originalUrl)`, and reject non-HTTP protocols or non-empty `username/password`. Never assign `url.href` to `originalUrl`.

Normalize leaf field names with:

```ts
const normalizedField = field.toLowerCase().replace(/_/g, '-');
```

Match the spec's credential list only as complete normalized names. Treat `authorization` as a header secret only beneath a `headers`/`requestHeaders` object or when its scalar value matches an auth-header shape; recurse into an `authorization` object so `.url` survives. An `_meta.botmux/linkRefPolicy === 'exclude'` skips that block/subtree. Return candidates in source order. Within one result, suppress repeat occurrences of the same byte-identical URL only after retaining the first occurrence's `sourceType/sourceId`; the ledger performs turn-wide byte-identical deduplication across later batches.

- [ ] **Step 6: Run focused extraction tests and build**

Run: `bunx vitest run test/link-ref-extractor.test.ts test/link-ref-sensitive-fields.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/services/link-ref-extractor.ts test/link-ref-extractor.test.ts \
  test/link-ref-sensitive-fields.test.ts
git commit -m "feat(link-ref): 提取原始链接并过滤凭证叶子"
```

### Task 3: Persist immutable turn-scoped refs in a daemon-only SQLite ledger

**Files:**
- Create: `src/services/link-ref-ledger.ts`
- Modify: `src/services/sqlite-compat.ts`
- Modify: `src/adapters/cli/fs-policy.ts`
- Modify: `src/worker.ts`
- Test: `test/link-ref-ledger.test.ts`
- Test: `test/link-ref-ledger-bun.test.ts`
- Modify: `test/fs-policy.test.ts`

**Interfaces:**
- Consumes: Task 1 identity/record/limit contracts and Task 2 candidates.
- Produces: the exact `LinkRefLedger` API in the locked interface section.
- Produces: `LinkRefRegistrationResult` with `registered`, `deduplicated`, `filteredByLimit`, and `failure?: LinkRefLedgerErrorCode`.
- Consumed by Tasks 4-12 only through `LinkRefLedger`; no caller constructs SQL.

- [ ] **Step 1: Write failing schema/immutability/isolation tests**

Create a temporary data dir and assert:

1. `openTurn` + `registerBatch` yields `lr_` plus 32 lowercase hex characters.
2. Re-registering the byte-identical URL in the same key returns the same ref.
3. Parameter order, duplicate params, percent encoding, and fragments produce separate refs.
4. `resolveBatch` fails with stable codes for another app/session/turn/attempt, unknown refs, expired refs, and settled-turn registration.
5. Closing/reopening `LinkRefLedger` preserves mappings.
6. `originalUrl` read back from expansion is byte-identical.
7. no update path can change an existing ref's URL.

Use deterministic `randomBytes` in tests so assertions do not depend on entropy.

- [ ] **Step 2: Run ledger tests and verify RED**

Run: `bunx vitest run test/link-ref-ledger.test.ts`

Expected: FAIL because the ledger is absent.

- [ ] **Step 3: Add failing limit/lifecycle/draft tests**

Assert the 129th distinct URL, a URL whose UTF-8 `Buffer.byteLength` is 8193, and the first distinct URL exceeding 512 KiB total are skipped without rolling back earlier valid registrations. Reusing an existing URL after the limit still returns its existing ref and consumes no capacity. Assert batch registration is atomic for accepted rows, final/failed/cancelled settlement rejects new registration, pending drafts survive reopen, settlement moves `expiresAtMs` to exactly `settledAtMs + 7 days`, `pruneExpired` observes the boundary, and `deleteSession(appA, session)` does not touch the same session id in appB.

- [ ] **Step 4: Add failing sandbox policy tests**

Extend `test/fs-policy.test.ts` to prove all of these paths remain `deny`/`none`, even when a user grants the enclosing data directory read-write:

```text
<dataDir>/link-refs
<dataDir>/link-refs/link-refs.sqlite
<dataDir>/link-refs/link-refs.sqlite-wal
<dataDir>/link-refs/link-refs.sqlite-shm
```

Also assert the existing per-session `turn-send-ledger` remains writable; the new deny must not collapse unrelated send fencing.

- [ ] **Step 5: Run lifecycle/policy tests and verify RED**

Run: `bunx vitest run test/link-ref-ledger.test.ts test/fs-policy.test.ts`

Expected: FAIL on ledger behavior and host-only masking.

- [ ] **Step 6: Implement the SQLite store and mandatory host-only mask**

Create `<dataDir>/link-refs` as `0700`, the database as `0600`, enable foreign keys and WAL, and set `busy_timeout = 50`. Retry `SQLITE_BUSY` at most three times with bounded jitter so one operation spends at most 200 ms waiting; do not retry identity, expiry, syntax, or capacity failures. Add transaction support to `DatabaseSyncLike` only if needed; otherwise use `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` without an `await` inside the transaction.

Use these tables and uniqueness rules:

```sql
CREATE TABLE link_ref_turns (
  app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  dispatch_attempt INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode = 'enabled'),
  state TEXT NOT NULL CHECK(state IN ('open','settled','expired')),
  created_at_ms INTEGER NOT NULL, last_activity_at_ms INTEGER NOT NULL,
  settled_at_ms INTEGER, expires_at_ms INTEGER NOT NULL,
  total_url_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(app_id, session_id, turn_id, dispatch_attempt)
);
CREATE TABLE link_refs (
  ref_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  dispatch_attempt INTEGER NOT NULL,
  original_url TEXT NOT NULL, url_hash TEXT NOT NULL,
  source_type TEXT NOT NULL, source_id TEXT, created_at_ms INTEGER NOT NULL,
  UNIQUE(app_id, session_id, turn_id, dispatch_attempt, url_hash, original_url),
  FOREIGN KEY(app_id, session_id, turn_id, dispatch_attempt)
    REFERENCES link_ref_turns(app_id, session_id, turn_id, dispatch_attempt) ON DELETE CASCADE
);
CREATE TABLE link_ref_pending_drafts (
  app_id TEXT NOT NULL, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
  dispatch_attempt INTEGER NOT NULL, content TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(app_id, session_id, turn_id, dispatch_attempt),
  FOREIGN KEY(app_id, session_id, turn_id, dispatch_attempt)
    REFERENCES link_ref_turns(app_id, session_id, turn_id, dispatch_attempt) ON DELETE CASCADE
);
```

Generate refs from `randomBytes(16).toString('hex')`; retry collisions without deriving IDs from URLs. Compute `url_hash` as lowercase SHA-256 hex over the exact UTF-8 `originalUrl` bytes. Use it only for indexed lookup/diagnostics, compare `original_url` to defeat hash collision ambiguity, and return original strings directly. Add `<dataDir>/link-refs` as a mandatory deny in both transport and no-transport policies; do not pre-create/mount it in `worker.ts`.

- [ ] **Step 7: Run focused tests under Node and a real Bun SQLite child**

Create `test/link-ref-ledger-bun.test.ts` with `spawnSyncBunTsEvalWithRepoImports` from `test/helpers/ts-runner.ts`. In the Bun child, import the real ledger, register/reopen/resolve one parameterized URL, and print `{ runtime, bunVersion, resolved }`; in the parent, assert `runtime === 'bun'`, `bunVersion` equals the pinned `packageManager` version, and `resolved` is byte-identical.

Run: `bunx vitest run test/link-ref-ledger.test.ts test/link-ref-ledger-bun.test.ts test/fs-policy.test.ts`

Expected: PASS in the normal Vitest runtime and the spawned Bun 1.4.3 `bun:sqlite` runtime.

- [ ] **Step 8: Commit Task 3**

```bash
git add src/services/link-ref-ledger.ts src/services/sqlite-compat.ts src/adapters/cli/fs-policy.ts \
  src/worker.ts test/link-ref-ledger.test.ts test/link-ref-ledger-bun.test.ts test/fs-policy.test.ts
git commit -m "feat(link-ref): 增加宿主不可变链接账本"
```

### Task 4: Present refs and expand only executable placeholder syntax

**Files:**
- Create: `src/services/link-ref-presenter.ts`
- Create: `src/services/link-ref-resolver.ts`
- Test: `test/link-ref-presenter.test.ts`
- Test: `test/link-ref-resolver.test.ts`

**Interfaces:**
- Consumes: `RegisteredLinkRef`, `LinkRefLedger`, and `LinkRefTurnKey` from Tasks 1 and 3.
- Produces: `renderLinkRefCompanion(refs: readonly RegisteredLinkRef[]): string`.
- Produces: `appendToolLinkRefCompanion<T extends { content?: unknown[] }>(value: T, refs: readonly RegisteredLinkRef[]): T`, appending `{ type: 'text', text: companion }`.
- Produces: `appendResourceLinkRefCompanion<T extends { contents?: unknown[] }>(value: T, refs: readonly RegisteredLinkRef[]): T`, appending `{ uri: 'botmux://link-refs/current-turn', mimeType: 'text/plain', text: companion }`.
- Produces: `findExecutableLinkRefs(text: string): { refIds: string[]; expand(resolved: ReadonlyMap<string, string>): string }`.
- Produces: the exact `resolveOutboundLinkRefs(...)` contract in the locked interface section.
- Consumed by all source adapters and outbound paths; no adapter implements its own replacement regex.

- [ ] **Step 1: Write failing companion formatting tests**

Assert deterministic source order, byte-identical displayed URLs, one row per byte-distinct URL, no block for an empty list, and these exact instructions:

```text
<botmux_link_refs>
lr_0123456789abcdef0123456789abcdef = https://example.test/p#Frag
引用或转发这个来源链接时，请输出 {{botmux_link:lr_0123456789abcdef0123456789abcdef}}。
如果有意只讨论域名或 base URL，可以直接输出普通 URL。
</botmux_link_refs>
```

For an MCP tool result, assert the original `content` blocks are deep-equal and one new `{ type: 'text' }` block is appended. For `resources/read`, assert the original `contents` are deep-equal and one valid synthetic text resource with URI `botmux://link-refs/current-turn` is appended. Do not merge the companion into a business JSON/string field.

- [ ] **Step 2: Run presenter tests and verify RED**

Run: `bunx vitest run test/link-ref-presenter.test.ts`

Expected: FAIL because the presenter is absent.

- [ ] **Step 3: Write failing lexical resolution tests**

Use a ledger fixture and cover:

````md
expand {{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}
literal `{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}`
literal fenced:
```
{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}
```
escaped \{{botmux_link:lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}}
malformed {{botmux_link:lr_AAAA}}
````

Assert only the first expands; code remains unchanged; escaped output loses one escape backslash and stays a literal placeholder. Add tilde/backtick fence lengths, language-labelled fences, multiple refs, repeated refs (one batch lookup), unknown/cross-turn refs, ordinary base URLs, and card objects with nested string/array leaves. Assert `expectedLinks` can contain a LinkRef and is returned as the expanded URL. Register an original URL whose query value itself contains a placeholder-shaped substring and assert expansion is single-pass: bytes inserted from the ledger are never tokenized or recursively expanded.

- [ ] **Step 4: Run resolver tests and verify RED**

Run: `bunx vitest run test/link-ref-resolver.test.ts`

Expected: FAIL because tokenization and expansion are absent.

- [ ] **Step 5: Implement presenter and two-phase resolver**

The tokenizer first walks text with CommonMark fence and inline-code state, records executable ref spans, and records escaped spans separately. `findExecutableLinkRefs` never queries storage. `resolveOutboundLinkRefs` recursively tokenizes every outbound text/card string, deduplicates ref IDs, performs exactly one `ledger.resolveBatch`, then replaces only the spans found in the first pass using the returned original strings. It never scans inserted URL bytes. When no executable refs exist it performs no ledger query, while still removing the one escape backslash from escaped literal placeholders.

Apply the same tokenizer to `expectedLinks`; after expansion, validate each value as an HTTP(S) URL. Throw stable errors `link_ref_unknown`, `link_ref_identity_mismatch`, `link_ref_expired`, `link_ref_ledger_unavailable`, and `expected_link_invalid_after_link_ref` without embedding ref URLs.

- [ ] **Step 6: Run focused tests and build**

Run: `bunx vitest run test/link-ref-presenter.test.ts test/link-ref-resolver.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/services/link-ref-presenter.ts src/services/link-ref-resolver.ts \
  test/link-ref-presenter.test.ts test/link-ref-resolver.test.ts
git commit -m "feat(link-ref): 生成引用协议并安全展开占位符"
```

### Task 5: Register initial model-visible sources at turn admission

**Files:**
- Create: `src/services/link-ref-runtime.ts`
- Create: `src/core/link-ref-turn.ts`
- Modify: `src/core/session-manager.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/daemon.ts`
- Modify: `src/types.ts`
- Test: `test/link-ref-turn-admission.test.ts`
- Modify: `test/prompt-builder.test.ts`
- Modify: `test/group-context-input.test.ts`
- Modify: `test/codex-app-clean-prompt.test.ts`

**Interfaces:**
- Consumes: config, extractor, ledger, and presenter from Tasks 1-4.
- Produces: `createLinkRefRuntime(dataDir, deps?): LinkRefRuntime`; construction opens SQLite only when `runtime.ledger()` is first called.
- Produces: `initialLinkRefSources(input): LinkRefSourceInput[]`, where only explicitly model-visible fields are accepted.
- Produces: `prepareLinkRefTurnPayload(input: { key; mode; payload }): CliTurnPayload`.
- Produces: daemon→worker `linkRefMode?: 'observe' | 'enabled'`; absence means disabled.
- Consumed by history/MCP registration and outbound resolution.

- [ ] **Step 1: Write failing disabled/observe/enabled admission tests**

Build opening and follow-up payload fixtures with user text, chat description, group history, card-visible text, a bounded `.md` attachment, and a hidden system instruction URL. Inject spies for extractor/ledger and assert:

- disabled returns the exact same `content` and `codexAppInput`, never calls extraction, and never asks for `runtime.ledger()`;
- observe scans the explicit sources and records only redacted statistics, but returns the same payload and never opens the ledger;
- enabled creates the turn, registers sources in one batch, appends one companion to legacy content, and adds `additionalContext.botmux_link_refs` to Codex App without rewriting `codexAppInput.text`;
- hidden system instruction and Skill-internal URLs are absent because they were never listed in `sources`;
- explicitly marked public system/document URLs are present with `sourceType: 'public_system_doc'`.

- [ ] **Step 2: Run admission tests and verify RED**

Run: `bunx vitest run test/link-ref-turn-admission.test.ts`

Expected: FAIL because runtime/admission preparation is absent.

- [ ] **Step 3: Add failing source and freeze-path tests**

Extend prompt tests so `buildNewTopicCliInput` and `buildFollowUpCliInput` attach source sidecars for:

```ts
expect(payload.linkRefs?.sources).toEqual(expect.arrayContaining([
  expect.objectContaining({ sourceType: 'user_message', kind: 'text' }),
  expect.objectContaining({ sourceType: 'group_context', kind: 'text' }),
]));
```

Use `sourceType: 'card'` when daemon parsing reports `msgType === 'interactive'`. Assert attachment scanning accepts only UTF-8 text extensions/MIME types, caps each file at 256 KiB, uses the repository's no-follow secure host-file read pattern, rejects symlinks/non-regular files/binary NUL content, and leaves attachment delivery unchanged when scanning fails. Assert a queued turn keeps its admission-time mode after global/Bot/env config objects change. Persist/reload a queued and pending-repository turn, then restart under administrator mode `disabled`; exact enabled turns recover as enabled through `readTurn(exactKey)`, while a different attempt and an observe turn do not borrow that row. Assert `BOTMUX_LINK_REFS_MODE` is absent from worker/CLI child env and only the frozen typed field crosses daemon→worker IPC.

- [ ] **Step 4: Run prompt/freeze tests and verify RED**

Run: `bunx vitest run test/link-ref-turn-admission.test.ts test/prompt-builder.test.ts test/group-context-input.test.ts test/codex-app-clean-prompt.test.ts`

Expected: FAIL on missing sources/mode freezing.

- [ ] **Step 5: Implement explicit source collection and admission preparation**

Add `linkRefSourceType?: 'user_message' | 'card'` and `publicSystemDocUrls?: string[]` to new-topic/follow-up options. Builders attach raw user/card text, untrusted group/chat context, attachment file descriptors, and explicit public docs to `payload.linkRefs.sources`; they do not scan or render companions.

At the two real admission boundaries—opening fork preparation and `sendWorkerInput` before queued/live routing—resolve the effective mode once. Call `prepareLinkRefTurnPayload` before storing queued activation payloads or sending worker IPC. Registration failure returns the payload without the failed refs and logs only the stable failure code/count. Strip `sources` before daemon→worker IPC and carry only the frozen non-disabled mode. Persist that mode in the existing queued/pending turn record and copy it through activation and transfer. On daemon/worker restart, restore an active/recoverable enabled turn by exact `(appId, sessionId, turnId, dispatchAttempt)` lookup through `ledger.readTurn`; never recompute it from current config and never search the ledger by a partial identity. Settled rows are used only when an explicitly frozen final/draft retry needs resolution, not to revive a turn. `observe` has no ledger row, so its pending record carries the frozen mode directly.

- [ ] **Step 6: Run focused prompt/admission tests and build**

Run: `bunx vitest run test/link-ref-turn-admission.test.ts test/prompt-builder.test.ts test/group-context-input.test.ts test/codex-app-clean-prompt.test.ts && bun run build`

Expected: PASS; legacy disabled snapshots are byte-identical and TypeScript exits 0.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/services/link-ref-runtime.ts src/core/link-ref-turn.ts src/core/session-manager.ts \
  src/core/worker-pool.ts src/daemon.ts src/types.ts test/link-ref-turn-admission.test.ts \
  test/prompt-builder.test.ts test/group-context-input.test.ts test/codex-app-clean-prompt.test.ts
git commit -m "feat(link-ref): 在轮次接纳时登记初始来源"
```

### Task 6: Register `history` and `quoted` results through authenticated host IPC

**Files:**
- Create: `src/core/link-ref-ipc.ts`
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/cli.ts`
- Modify: `src/core/managed-origin-capability.ts`
- Modify: `src/core/managed-origin-attestation.ts`
- Modify: `src/core/session-marker.ts`
- Modify: `src/worker.ts`
- Modify: `src/types.ts`
- Test: `test/link-ref-session-cli-ipc.test.ts`
- Modify: `test/history-thread-window.test.ts`
- Test: `test/quoted-link-ref.test.ts`

**Interfaces:**
- Consumes: runtime extraction/registration/presentation and frozen mode from Task 5.
- Produces: session CLI route `POST /api/sessions/:sessionId/link-refs/register`.
- Produces: `postSessionCliIpc(..., 'link-refs-register', { sourceType, sourceId?, value }): { companion?: string; stats }`.
- Produces: frozen `linkRefMode` in managed-origin capability/attestation/session marker records.
- Consumed by `botmux history`, `botmux quoted`, and later sandbox/host re-exec sends.

- [ ] **Step 1: Write failing broker authorization/bounds tests**

Add cases for trusted-host HMAC and rotating turn capability success, stale capability, closed session, mismatched session, settled turn, disabled mode, and bodies over 1 MiB. The request body must not be allowed to select app/turn/attempt/mode. Assert disabled requests return `{ companion: undefined }` without accessing extractor/ledger; enabled requests derive the exact live key and return a companion; ledger failure returns success with no companion and the original result untouched.

- [ ] **Step 2: Run IPC tests and verify RED**

Run: `bunx vitest run test/link-ref-session-cli-ipc.test.ts`

Expected: FAIL because the route and DTO validator are absent.

- [ ] **Step 3: Write failing command-output tests**

For `history`, serve text, card JSON, and resource entries containing parameterized URLs; assert the original JSON fields remain unchanged and the final JSON gains only `linkRefs.companion`. For `quoted`, add `test/quoted-link-ref.test.ts` around the command boundary with rendered text, raw card JSON, and downloaded text attachment paths; keep `test/quoted-render.test.ts` as the pure rendering regression. Assert a history result read in a later turn receives fresh refs, disabled mode emits the exact prior stdout, and authorization links retain all parameters.

- [ ] **Step 4: Run command tests and verify RED**

Run: `bunx vitest run test/history-thread-window.test.ts test/quoted-link-ref.test.ts`

Expected: FAIL because outputs never register/append refs.

- [ ] **Step 5: Implement the bounded broker and command integration**

Extend the existing capability file/session marker with the frozen mode whenever the worker publishes a live turn. `cmdHistory`/`cmdQuoted` read that trusted snapshot; absence means disabled and performs no new IPC. Observe/enabled commands submit the already-built result to the daemon route. Observe returns stats only; enabled appends the returned companion as a top-level `linkRefs` object after all history/card/resource expansion and quoted downloads complete. Do not write the ledger from `cli.ts`.

The route uses `sessionCliIpcAuth`, derives identity from the current `managedTurnOrigin`, invokes `collectLinkRefCandidates`, and calls one `registerBatch`. Unknown/failed registrations return HTTP 200 with redacted stats and no companion so the command's original business result remains usable.

- [ ] **Step 6: Run focused IPC/CLI tests and build**

Run: `bunx vitest run test/link-ref-session-cli-ipc.test.ts test/history-thread-window.test.ts test/quoted-link-ref.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 6**

```bash
git add src/core/link-ref-ipc.ts src/core/dashboard-ipc-server.ts src/cli.ts \
  src/core/managed-origin-capability.ts src/core/managed-origin-attestation.ts \
  src/core/session-marker.ts src/worker.ts src/types.ts \
  test/link-ref-session-cli-ipc.test.ts test/history-thread-window.test.ts test/quoted-link-ref.test.ts
git commit -m "feat(link-ref): 为历史与引用结果登记来源链接"
```

### Task 7: Register structured MCP results and gate trusted host delivery

**Files:**
- Modify: `src/core/plugins/mcp/gateway.ts`
- Modify: `src/core/plugins/mcp/host.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/worker.ts`
- Modify: `src/types.ts`
- Test: `test/plugin-mcp-link-ref.test.ts`
- Modify: `test/plugin-mcp-gateway.test.ts`
- Modify: `test/plugin-trusted-result-delivery.test.ts`

**Interfaces:**
- Consumes: Task 2 structured traversal, Task 4 presenter, Task 5 frozen mode, and Task 3 daemon ledger.
- Produces: `GatewayTrustedTurnIdentity.linkRefMode?: 'observe' | 'enabled'`.
- Produces: `GatewayLinkRefRegistrationHandler(input): Promise<{ companion?: string; stats }>`.
- Produces worker IPC messages `link_ref_register` and `link_ref_register_result`, bound to the worker generation and active turn.
- Produces LinkRef resolution of local MCP trusted-delivery Markdown before its first upload/card/send effect; the downstream result replaced by a receipt is not treated as model-visible source data.

- [ ] **Step 1: Write failing MCP result coverage tests**

Create downstream results containing:

- a `text` content block with a bytecli permission error and full authorization URL;
- an embedded text `resource`;
- JSON string leaves including `authorization.url`, credential leaves, and an excluded subtree;
- an image/blob content block.

Assert enabled mode preserves the entire original result object and appends exactly one schema-valid companion (`type: 'text'` content for `tools/call`, synthetic text resource for `resources/read`), observe mode emits stats without a block/resource, disabled mode never calls the registration handler, and binary content is not decoded. Cover both request types.

- [ ] **Step 2: Run MCP tests and verify RED**

Run: `bunx vitest run test/plugin-mcp-link-ref.test.ts test/plugin-mcp-gateway.test.ts`

Expected: FAIL because Gateway returns downstream results unchanged and has no registration handler.

- [ ] **Step 3: Add failing identity/race tests**

Start a tool call under turn A, advance active authority to turn B before the downstream promise resolves, and assert registration still uses the identity frozen at call start but is rejected if A is already settled. Add stale worker generation, cross-session, missing turn, and daemon-restart/reopened-ledger cases. Assert the model still receives the original result without a companion when registration fails.

Extend `test/plugin-trusted-result-delivery.test.ts`: place a valid existing LinkRef in `_meta.botmux/hostDelivery.markdown`, assert daemon expansion precedes artifact persistence/card rendering/Lark send, and assert an unknown ref produces no delivery side effect or receipt. The hidden business result that is replaced wholesale by the delivery receipt must not be registered or appended with a companion.

- [ ] **Step 4: Run race tests and verify RED**

Run: `bunx vitest run test/plugin-mcp-link-ref.test.ts`

Expected: FAIL on missing frozen-mode/worker IPC behavior.

- [ ] **Step 5: Implement trusted worker→daemon registration**

Freeze `linkRefMode` inside `currentGatewayTrustedTurnIdentity()` together with turn/attempt/caller. For ordinary downstream tool/resource responses, invoke registration only for observe/enabled before returning to the external CLI. Worker sends a bounded structured value plus its frozen identity over IPC; daemon verifies current worker generation, app/session binding, and ledger turn state, then returns only companion/stats. The Gateway calls `appendToolLinkRefCompanion` for `tools/call` and `appendResourceLinkRefCompanion` for `resources/read`, without spreading or rewriting downstream business data.

When `_meta.botmux/hostDelivery` is present, the original downstream result is not model-visible: skip source registration, pass the frozen `linkRefMode` with the existing trusted delivery IPC, and resolve `delivery.markdown` in the daemon against that exact identity before artifact persistence, rendering, uploads, or sends. Disabled mode remains byte-identical. Unknown/expired/cross-boundary refs reject the delivery with a stable non-sensitive code and no receipt; do not send the placeholder or fall back to guessing.

- [ ] **Step 6: Run MCP suite and build**

Run: `bunx vitest run test/plugin-mcp-link-ref.test.ts test/plugin-mcp-gateway.test.ts test/plugin-trusted-result-delivery.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/core/plugins/mcp/gateway.ts src/core/plugins/mcp/host.ts src/core/worker-pool.ts \
  src/worker.ts src/types.ts test/plugin-mcp-link-ref.test.ts test/plugin-mcp-gateway.test.ts \
  test/plugin-trusted-result-delivery.test.ts
git commit -m "feat(link-ref): 登记 MCP 结构化结果链接"
```

### Task 8: Resolve LinkRefs in `botmux send` before validation and effects

**Files:**
- Modify: `src/core/link-ref-ipc.ts`
- Modify: `src/core/dashboard-ipc-server.ts`
- Modify: `src/cli.ts`
- Modify: `src/services/link-ref-resolver.ts`
- Test: `test/cli-send-link-ref.test.ts`
- Modify: `test/cli-send-expected-link.test.ts`
- Modify: `test/cli-send-hook-context.test.ts`

**Interfaces:**
- Consumes: Task 4 resolver, Task 5 frozen mode, and Task 6 authenticated session CLI transport.
- Produces: session CLI route `POST /api/sessions/:sessionId/link-refs/resolve`.
- Produces: `resolveLinkRefsThroughSessionHost(input: OutboundLinkRefPayload): Promise<ResolvedOutboundLinkRefs>` in `cli.ts`.
- Consumed indirectly by sandbox and Remote Runner re-entry in Task 10.

- [ ] **Step 1: Write failing body/content-file/expected-link tests**

Register a URL whose exact value includes an unsorted query, repeated key, empty value, percent encoding, and fragment:

```ts
const dacuHost = 'source.example.test';
const fullUrl = `https://${dacuHost}/preview_platform/problem`
  + '?b=2&a=1&a=&redirect=%2Ffoo%3Fx%3D1#timeline';
```

Invoke `botmux send` with its LinkRef as positional content, stdin, and `--content-file`, across progress, final, and auxiliary response kinds; assert the Lark mock receives the exact full URL. Add `--expected-link '{{botmux_link:...}}'` and an ordinary full `--expected-link`, and assert both validations happen against expanded rendered content. Add the ordinary base URL built from `dacuHost` and assert it is neither supplemented nor rejected.

- [ ] **Step 2: Run text/expected-link tests and verify RED**

Run: `bunx vitest run test/cli-send-link-ref.test.ts test/cli-send-expected-link.test.ts`

Expected: FAIL because CLI send validates/renders/fingerprints unexpanded placeholders.

- [ ] **Step 3: Write failing custom-card and pre-effect ordering tests**

Put refs in nested custom-card Markdown, button URLs, and array string values. Assert all executable refs expand and code literals remain unchanged. Use spies to prove an unknown ref fails before each of these callbacks:

```text
prepareCardMarkdown / TTS / contact lookup / upload / turn-send ledger execute /
Lark send / outbound hook
```

Add a sandbox-prepared Markdown fixture (`BOTMUX_CARD_PREPARED_CONTENT_FILE`) and assert its in-memory `preparedText` is expanded before `--expected-link` validation and fingerprint calculation. Assert the source file is not rewritten.

- [ ] **Step 4: Run card/order tests and verify RED**

Run: `bunx vitest run test/cli-send-link-ref.test.ts test/cli-send-hook-context.test.ts`

Expected: FAIL because no host resolution precedes these effects.

- [ ] **Step 5: Implement the authenticated resolve broker and reorder send preflight**

The route accepts at most 4 MiB JSON, authenticates with `sessionCliIpcAuth`, derives key/mode from live daemon state, and refuses caller-selected identity/mapping fields. The CLI derives mode from the trusted session marker/capability; `BOTMUX_LINK_REF_TURN_MODE` is only a host-owned relay hint and cannot override that marker. Disabled mode is never sent to the route. Enabled mode with no executable refs returns locally from `findExecutableLinkRefs` and sends no IPC. Observe mode has no injected refs and therefore performs only the existing send path.

In `cmdSend`, move HTTP(S) validation of `--expected-link` until after source/card files are read and LinkRefs are resolved. Resolve `{ text: content, preparedText, card: customCard, expectedLinks }` immediately after input/card normalization and before any Markdown rendering, TTS, contacts, upload, durable-send, fingerprint, hook, or platform call. Use resolved values for `expectedLinkRenderedContent`, `turnRequestIdentity`, custom-card serialization, and provider dispatch. Never mutate the caller's content/card file.

On `413`, ledger error, unknown/cross-boundary/expired ref, or malformed resolved expected link, print a stable `botmux send refused: link_ref_*` diagnostic and exit 2 before side effects. Map an oversized resolve body to `link_ref_limit_exceeded`; never leak raw server/database text. Do not fall back to sending the placeholder or guessing a URL.

- [ ] **Step 6: Run CLI send suites and build**

Run: `bunx vitest run test/cli-send-link-ref.test.ts test/cli-send-expected-link.test.ts test/cli-send-hook-context.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 8**

```bash
git add src/core/link-ref-ipc.ts src/core/dashboard-ipc-server.ts src/cli.ts \
  src/services/link-ref-resolver.ts test/cli-send-link-ref.test.ts \
  test/cli-send-expected-link.test.ts test/cli-send-hook-context.test.ts
git commit -m "feat(link-ref): 在 CLI 发送副作用前展开链接引用"
```

### Task 9: Resolve automatic finals and retain retryable drafts

**Files:**
- Modify: `src/types.ts`
- Modify: `src/worker.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/services/link-ref-runtime.ts`
- Test: `test/worker-final-link-ref.test.ts`
- Modify: `test/bridge-final-output-retry.test.ts`
- Modify: `test/async-usage-glue.test.ts`

**Interfaces:**
- Consumes: Task 3 draft/ledger API and Task 4 resolver.
- Produces: `WorkerToDaemon.final_output.linkRefMode?: 'observe' | 'enabled'` copied from the active turn.
- Produces: `LinkRefRuntime.resolveForDaemon(key, mode, payload)`; disabled returns the original object without constructing the ledger.
- Produces: automatic-final draft recovery through `savePendingDraft/readPendingDraft/clearPendingDraft`.
- Consumed by Task 11 lifecycle settlement and restart verification.

- [ ] **Step 1: Write failing automatic-final output tests**

For enabled turns, emit a `final_output` with a LinkRef and assert exact expansion occurs before:

- HTTP wait/async result persistence;
- document-comment chunking;
- VC listener envelope parsing;
- image preparation and Markdown card rendering;
- Lark reply and final-delivery fingerprint/dedupe.

Cover ordinary Lark, doc comment, HTTP wait, HTTP async, and no-transport result sinks. Assert disabled finals remain byte-identical and never request the LinkRef runtime ledger.

- [ ] **Step 2: Run final-output tests and verify RED**

Run: `bunx vitest run test/worker-final-link-ref.test.ts test/async-usage-glue.test.ts`

Expected: FAIL because `deliverFinalOutput` consumes raw model content.

- [ ] **Step 3: Write failing failure/draft/restart tests**

Let `savePendingDraft` succeed, then make ledger resolution throw `SQLITE_BUSY` through all bounded retries. Assert no callback above is invoked, the exact unresolved content was durably stored before the first resolve attempt, the user never receives a placeholder, and delivery remains retryable. Reopen the ledger/runtime, retry the same final after storage recovers, and assert one expanded delivery plus draft deletion. Add a separate initial-draft-write failure case: it must fail closed before resolve/delivery, keep the existing in-process retry source authoritative, and emit only a stable code. Add unknown/cross-turn refs and ensure retry never falls back to same-origin/path reconstruction.

- [ ] **Step 4: Run retry tests and verify RED**

Run: `bunx vitest run test/worker-final-link-ref.test.ts test/bridge-final-output-retry.test.ts`

Expected: FAIL because there is no draft persistence or resolution gate.

- [ ] **Step 5: Implement automatic-final resolution at the first delivery boundary**

Worker copies the active turn's non-disabled frozen mode into every final/failure carrier. In `deliverFinalOutput`, before wait/async interception or any content parsing, tokenize a local copy of `msg.content`. If an enabled final has executable refs, save the exact unresolved draft first, then resolve it using `(ds.larkAppId, sessionId, turnId, dispatchAttempt)`; a draft-write failure itself is fail-closed. If it has no executable refs, avoid the ledger entirely but still apply the lexical transform for escaped literals. Never mutate the worker IPC object used by unrelated accounting. On resolution failure, the already-persisted draft remains, log only key/ref/error counts, call the existing bounded retry path, and leave completion unproven. On success, every downstream sink uses the expanded string and clears the draft only after its primary delivery/result persistence succeeds.

When a daemon restart observes a pending draft and receives the same turn's replay/final, prefer the persisted draft only if its key exactly matches. Existing turn-send/provider UUID fences remain authoritative, so recovery cannot duplicate a proven send.

- [ ] **Step 6: Run automatic-final suites and build**

Run: `bunx vitest run test/worker-final-link-ref.test.ts test/bridge-final-output-retry.test.ts test/async-usage-glue.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 9**

```bash
git add src/types.ts src/worker.ts src/core/worker-pool.ts src/services/link-ref-runtime.ts \
  test/worker-final-link-ref.test.ts test/bridge-final-output-retry.test.ts test/async-usage-glue.test.ts
git commit -m "feat(link-ref): 展开自动最终答复并保留失败草稿"
```

### Task 10: Preserve trusted mode through sandbox relay and Remote Runner

**Files:**
- Modify: `src/adapters/backend/sandbox.ts`
- Modify: `src/adapters/backend/remote-runner-backend.ts`
- Modify: `src/adapters/backend/remote-runner-protocol.ts`
- Modify: `src/services/remote-runner-outbound-send.ts`
- Modify: `src/worker.ts`
- Modify: `src/types.ts`
- Test: `test/sandbox-relay-link-ref.test.ts`
- Test: `test/remote-runner-link-ref.test.ts`
- Modify: `test/remote-runner-outbound-send.test.ts`

**Interfaces:**
- Consumes: frozen worker mode from Task 5 and CLI host resolution from Task 8.
- Produces: `startOutboxWatcher(...).authorize().origin.linkRefMode?: 'observe' | 'enabled'`.
- Produces: `RemoteRunnerOutboundHostContext.linkRefMode?: 'observe' | 'enabled'` and provider-neutral propagation on active turn state only.
- Does not expose ledger paths, rows, raw URLs, or mappings to sandbox/provider.

- [ ] **Step 1: Write failing sandbox relay tests**

Have a sandbox request carry a LinkRef in content/card data and maliciously claim `linkRefMode: 'disabled'` plus a fake mapping. Assert the watcher ignores both, freezes mode from `authorize`, forces the exact session/turn/attempt, and its host re-exec ultimately sends the expanded URL. Unknown refs return relay exit 2 before upload/provider calls. Disabled authorized turns preserve the existing relay request, args, environment, and call count.

- [ ] **Step 2: Run sandbox tests and verify RED**

Run: `bunx vitest run test/sandbox-relay-link-ref.test.ts`

Expected: FAIL because the watcher does not propagate the trusted mode.

- [ ] **Step 3: Write failing Remote Runner final/outbound tests**

Cover both provider events:

1. `final` reaches automatic-final resolution and exact expansion;
2. `outbound_message` re-enters `botmux send` and resolves before its fingerprint/network effect.

Assert the provider sees only the ref/companion protocol and never receives the ledger/mapping. Add a forged provider mode/mapping field and ensure protocol parsing drops/rejects it. Add an unknown ref and assert `outbound_message_result` is `rejected` with a stable non-sensitive code; no automatic retry occurs for an unknown delivery outcome.

- [ ] **Step 4: Run Remote Runner tests and verify RED**

Run: `bunx vitest run test/remote-runner-link-ref.test.ts test/remote-runner-outbound-send.test.ts`

Expected: FAIL because Remote Runner contexts do not preserve LinkRef turn mode.

- [ ] **Step 5: Implement trusted relay propagation**

Extend only host-owned origin/context objects with frozen mode. `startOutboxWatcher` removes both the administrator-only `BOTMUX_LINK_REFS_MODE` and any caller-supplied `BOTMUX_LINK_REF_TURN_MODE`, then sets `BOTMUX_LINK_REF_TURN_MODE` from `authorize().origin`; CLI resolution still authenticates against daemon state and never trusts the hint as identity or configuration. `sendRemoteRunnerOutboundMessage` does the same for the worker-owned context. `RemoteRunnerBackend` retains mode beside the active acknowledged turn and copies it to final callbacks/outbound host callbacks; protocol JSON from providers has no accepted mode/mapping fields.

- [ ] **Step 6: Run relay suites and build**

Run: `bunx vitest run test/sandbox-relay-link-ref.test.ts test/remote-runner-link-ref.test.ts test/remote-runner-outbound-send.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 10**

```bash
git add src/adapters/backend/sandbox.ts src/adapters/backend/remote-runner-backend.ts \
  src/adapters/backend/remote-runner-protocol.ts src/services/remote-runner-outbound-send.ts \
  src/worker.ts src/types.ts test/sandbox-relay-link-ref.test.ts \
  test/remote-runner-link-ref.test.ts test/remote-runner-outbound-send.test.ts
git commit -m "feat(link-ref): 覆盖沙箱与远程运行器发送路径"
```

### Task 11: Settle lifecycle, clean retention, and emit redacted diagnostics

**Files:**
- Modify: `src/services/link-ref-runtime.ts`
- Modify: `src/services/link-ref-ledger.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/daemon.ts`
- Modify: `src/index-daemon.ts`
- Test: `test/link-ref-lifecycle.test.ts`
- Test: `test/link-ref-observability.test.ts`
- Modify: `test/close-stream-card-untouched.test.ts`

**Interfaces:**
- Consumes: terminal/session identities and ledger APIs from earlier tasks.
- Produces: `LinkRefRuntime.settleTurn`, `deleteSession`, `pruneExpired`, and `recordDiagnostic` wrappers that never log raw URLs.
- Produces: lazy-start maintenance: the first enabled turn admission/recovery opens the ledger, immediately prunes it, and starts one unref'd daily prune timer. A disabled/observe-only fleet never opens an existing ledger merely to clean it.

- [ ] **Step 1: Write failing terminal/close/prune tests**

Assert completed, failed, cancelled, and ambiguous `turn_terminal` states all settle the exact turn after final-output resolution can still read settled refs. Assert settled turns reject later registration but remain resolvable for 7 days. Assert successful session close deletes all app/session rows and drafts, close refusal deletes nothing, another app with the same session ID is untouched, and daemon restart can resolve unexpired rows. Assert open inactivity expiration and settled retention use exact boundary timestamps.

- [ ] **Step 2: Run lifecycle tests and verify RED**

Run: `bunx vitest run test/link-ref-lifecycle.test.ts test/close-stream-card-untouched.test.ts`

Expected: FAIL because terminals/close/startup are not wired to the ledger.

- [ ] **Step 3: Write failing redaction/observe tests**

Capture logs/diagnostics for normal, authorization, filtered-secret, limit, registration failure, unknown ref, and resolution timing cases. Assert allowed fields are limited to:

```text
mode, sourceType, scannedBytes, found, registered, deduplicated, filtered,
limited, refId, urlHash, outcome, errorCode, refCount, durationMs
```

Search captured output for raw hostname/path/query values, Bearer/cookie/password values, companion tags, and URL fragments; expect no match. Assert observe mode reports scan counts but creates no DB file, prompt companion, or outbound mutation.

- [ ] **Step 4: Run observability tests and verify RED**

Run: `bunx vitest run test/link-ref-observability.test.ts`

Expected: FAIL because diagnostics/lifecycle policy are not centralized.

- [ ] **Step 5: Implement settlement, cleanup, and safe diagnostics**

In `turn_terminal`, call `settleTurn` after delivery-resolution work has captured/expanded content; settling must not prevent reads. In the successful `closeSession` commit path call `deleteSession`. Do not open the database from unconditional daemon startup. The lazy `ledger()` initializer prunes immediately on its first enabled admission/recovery and creates one 24-hour unref'd prune timer; observe/disabled calls never reach it. Ledger/runtime catch database maintenance failures and log stable codes without affecting unrelated sessions.

Centralize all LinkRef diagnostics in `LinkRefRuntime.recordDiagnostic(event)`, explicitly project the allowlisted scalar fields above, and hash URLs before the diagnostic boundary. Observe mode calls only Task 2 extraction plus this projector and never calls `ledger()`.

- [ ] **Step 6: Run lifecycle/observability suites and build**

Run: `bunx vitest run test/link-ref-lifecycle.test.ts test/link-ref-observability.test.ts test/close-stream-card-untouched.test.ts && bun run build`

Expected: PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 11**

```bash
git add src/services/link-ref-runtime.ts src/services/link-ref-ledger.ts src/core/worker-pool.ts \
  src/daemon.ts src/index-daemon.ts test/link-ref-lifecycle.test.ts \
  test/link-ref-observability.test.ts test/close-stream-card-untouched.test.ts
git commit -m "feat(link-ref): 接入轮次生命周期与脱敏观测"
```

### Task 12: Prove end-to-end behavior and horizontal compatibility

**Files:**
- Create: `test/link-ref-e2e.test.ts`
- Modify: `test/worker-argv-reaction-status.integration.test.ts`
- Modify: `test/fs-policy.test.ts`
- Modify: `docs/superpowers/specs/2026-10-19-link-ref-url-integrity-design.md` only if implementation discovered a factual mismatch; behavior changes require user approval before editing the spec.

**Interfaces:**
- Consumes every prior task contract.
- Produces no new production interface; produces a verified branch ready for review/live gray deployment.

- [ ] **Step 1: Add the end-to-end acceptance test**

Exercise this exact flow with real extractor, SQLite ledger, presenter, authenticated broker, and mocked Lark provider:

```text
user source is exactly
https://<runtime-constructed source host>/preview_platform/problem#timeline
→ companion ref delivered to model fixture
→ model fixture emits only {{botmux_link:lr_...}}
→ outbound resolver expands it
→ --expected-link validates the expanded URL
→ turn-send fingerprint uses expanded content
→ provider receives the exact original bytes once
```

In the same test send the plain source base URL and assert it remains plain. Repeat with a bytecli-style authorization URL containing `code`, `token`, `signature`, `state`, and `redirect_uri`, and assert it remains usable; include a Bearer header and assert it never enters the ledger/companion/log.

- [ ] **Step 2: Run the end-to-end test and verify GREEN**

Run: `bunx vitest run test/link-ref-e2e.test.ts`

Expected: PASS with the exact URL byte comparison and zero provider calls for the unknown-ref case.

- [ ] **Step 3: Run the feature-focused matrix**

Run:

```bash
bunx vitest run \
  test/link-ref-config.test.ts \
  test/bot-registry-link-ref.test.ts \
  test/link-ref-extractor.test.ts \
  test/link-ref-sensitive-fields.test.ts \
  test/link-ref-ledger.test.ts \
  test/link-ref-ledger-bun.test.ts \
  test/link-ref-presenter.test.ts \
  test/link-ref-resolver.test.ts \
  test/link-ref-turn-admission.test.ts \
  test/link-ref-session-cli-ipc.test.ts \
  test/quoted-link-ref.test.ts \
  test/plugin-mcp-link-ref.test.ts \
  test/cli-send-link-ref.test.ts \
  test/worker-final-link-ref.test.ts \
  test/sandbox-relay-link-ref.test.ts \
  test/remote-runner-link-ref.test.ts \
  test/link-ref-lifecycle.test.ts \
  test/link-ref-observability.test.ts \
  test/link-ref-e2e.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 4: Run horizontal regression slices**

Run targeted existing tests proving the common layer did not regress:

```bash
bunx vitest run \
  test/prompt-builder.test.ts \
  test/codex-input.e2e.ts \
  test/claude-code-input.e2e.ts \
  test/cli-send-expected-link.test.ts \
  test/cli-send-hook-context.test.ts \
  test/plugin-mcp-gateway.test.ts \
  test/plugin-trusted-result-delivery.test.ts \
  test/fs-policy.test.ts \
  test/remote-runner-outbound-send.test.ts \
  test/fork-session.test.ts \
  test/transfer-session.test.ts \
  test/session-store-sqlite.test.ts
```

This matrix covers Codex + Claude Code, PTY + persistent Tmux paths, sandbox on/off, normal topic + chat-scope + restored/transferred sessions, and Remote Runner. For non-Lark behavior, add a unit fixture around the transport-neutral resolver and assert an adapter without an authenticated LinkRef turn remains on the exact disabled path; do not silently enable LinkRefs at an unsupported IM boundary.

- [ ] **Step 5: Run full unit suite, Bun compatibility, and production build**

Run:

```bash
bun run test
bun run test:bun
bun run build
git diff --check origin/master...HEAD
```

Expected: unit suite, Bun-specific tests, TypeScript/build/audits, and whitespace check all exit 0.

- [ ] **Step 6: Audit disabled-path performance and source coverage**

Run the existing test suite under spies that throw if disabled mode reaches `extractHttpUrlSpans`, `openDatabaseSyncOrThrow`, LinkRef IPC routes, or `findExecutableLinkRefs`. Inspect every `final_output`, `botmux send`, custom card, content-file, sandbox outbox, Remote Runner final/outbound, history, quoted, and MCP return call site with:

```bash
rg -n "final_output|cmdSend|startOutboxWatcher|outbound_message|cmdHistory|cmdQuoted|CallToolRequestSchema|ReadResourceRequestSchema" src
```

Expected: each supported entry/exit maps to the single public registration/resolution API; ordinary stdout remains explicitly outside first-release coverage; no direct LinkRef SQL/path access exists outside `link-ref-ledger.ts`/runtime startup.

- [ ] **Step 7: Commit acceptance coverage**

```bash
git add test/link-ref-e2e.test.ts test/worker-argv-reaction-status.integration.test.ts \
  test/fs-policy.test.ts
git commit -m "test(link-ref): 覆盖链接完整性端到端与横向回归"
```

- [ ] **Step 8: Perform completion review**

Use `requesting-code-review` against the spec and final diff. Any Critical or Important finding receives a scoped failing regression test, fix commit, and re-review. Then use `verification-before-completion`; do not deploy, restart the live daemon, change global/Bot mode, push, or open a PR unless the user separately requests those external changes.
