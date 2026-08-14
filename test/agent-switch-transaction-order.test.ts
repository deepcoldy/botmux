/**
 * Transactional correctness of the agent-switch handler.
 *
 * Two failures this pins, both found in review after the mojo remote-close work
 * added irreversible closes to this handler:
 *
 *   ① a PURE precondition ran after the irreversible close. `agentSwitchCloseHook`
 *      closes every session frozen on the old agent and cannot be undone, yet the
 *      reasoning-effort model-support check sat inside the transaction below it.
 *      A merely invalid request (codex + a model that rejects `ultra`) therefore
 *      tore down live sessions and only then answered 400 — breaking "a failed
 *      validation produces no side effects".
 *
 *   ② the client decided "this response came after the closes" by ENUMERATING two
 *      error codes. The server grew a fourth post-close exit carrying the same
 *      summary, so the surviving remote task ids were rendered nowhere and an
 *      operator had no handle to clean them up.
 *
 * Both are guarded structurally rather than by example, because the enumeration
 * itself was the bug: a fifth post-close exit must not be able to reintroduce it.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const ipc = readFileSync(
  new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const page = readFileSync(
  new URL('../src/dashboard/web/bot-defaults-page.tsx', import.meta.url), 'utf8');

/**
 * Start offset of the agent-switch handler. Anchored on the route registration
 * rather than an offset from some nearby variable: earlier guards computed the
 * gate position as `indexOf(marker) - 4000`, which silently pointed at the NEXT
 * handler's gate once code was inserted above, turning real ordering assertions
 * into false failures.
 */
function agentHandlerAt(): number {
  const at = ipc.indexOf("ipcRoute('PUT', '/api/bot-agent'");
  expect(at, 'agent-switch route registration').toBeGreaterThan(0);
  return at;
}

/** The mutation gate belonging to the agent-switch handler. */
function agentGateAt(): number {
  const at = ipc.indexOf('return withBotTurnMutation(larkAppId, async () => {', agentHandlerAt());
  expect(at, 'agent-switch mutation gate').toBeGreaterThan(0);
  return at;
}

/** Body of the agent-switch handler, from the close hook to the success commit. */
function postCloseRegion(): string {
  const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
  expect(closeAt, 'agentSwitchCloseHook.run call site').toBeGreaterThan(0);
  const commitAt = ipc.indexOf('const bot = getBot(larkAppId);', closeAt);
  expect(commitAt, 'post-close success commit').toBeGreaterThan(closeAt);
  return ipc.slice(closeAt, commitAt);
}

describe('agent switch — no precondition runs after the irreversible close', () => {
  it('rejects an unsupported reasoning effort BEFORE the close hook', () => {
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    const preflightAt = ipc.indexOf('const preflightReasoningEffort =');
    expect(preflightAt, 'preflight precondition must exist').toBeGreaterThan(0);
    expect(
      preflightAt,
      'the model-support precondition must be evaluated before any irreversible close',
    ).toBeLessThan(closeAt);

    // …and it must actually return, not merely compute a value.
    const preflight = ipc.slice(preflightAt, closeAt);
    expect(preflight).toContain("error: 'reasoning_effort_not_supported_by_model'");
    expect(preflight).toContain('return jsonRes(res, 400');
  });

  it('reads the SAME authority the transaction uses (disk), before any close', () => {
    // This assertion previously pinned `currentBotConfig.reasoningEffort` — i.e. it
    // froze the bug into a contract, so the correct fix would have failed the guard.
    // getBot().config is a separate in-memory snapshot that can ALREADY disagree
    // with disk before the request arrives, so every value this handler derives
    // must come from the persisted row.
    const authorityAt = ipc.indexOf('let persistedBotRow');
    expect(authorityAt, 'a single authority snapshot must be read').toBeGreaterThan(0);
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    const preflight = ipc.slice(authorityAt, closeAt);

    // Same source as the transaction: the on-disk row, read under the same
    // cross-process lock the commit uses (a write:false rmw), so the snapshot and
    // its version always describe one committed state.
    expect(preflight).toContain('rmwBotEntry<');
    expect(preflight).toContain('write: false');
    // Positional, not a substring that appears everywhere: the authority must be
    // resolved before the irreversible close.
    expect(
      authorityAt,
      'the authority snapshot must be read before any irreversible close',
    ).toBeLessThan(closeAt);
    // The derived selection/runtime/reasoning values must all come from that
    // snapshot. `currentBotConfig` is now the persisted row, so the live snapshot
    // must not be consulted anywhere between the snapshot and the close.
    expect(
      preflight,
      'no decision between the authority read and the close may use the live config',
    ).not.toContain('getBot(larkAppId).config');
  });

  it('derives the close target from the persisted row, not the live snapshot', () => {
    // The switch target decides WHICH sessions are irreversibly closed and which
    // runtime fields get written. Deriving it from memory closed the wrong target
    // and silently erased a persisted cliRuntime/cliPathOverride.
    const targetAt = ipc.indexOf('const switchTarget = {');
    expect(targetAt, 'switch target must exist').toBeGreaterThan(0);
    const targetBlock = ipc.slice(targetAt, ipc.indexOf('};', targetAt));
    expect(targetBlock, 'close target must not read the live config')
      .not.toContain('getBot(');
  });

  it('normalises the raw row with the loader default instead of a local literal', () => {
    // A raw row may omit cliId; the loader treats that as claude-code. Deriving a
    // selection without that default made a legacy row look changed and deleted
    // its cliPathOverride. Re-declaring the literal here would let the two drift
    // apart again, so the shared constant must be used.
    const registry = readFileSync(
      new URL('../src/bot-registry.ts', import.meta.url), 'utf8');
    expect(registry, 'the legacy default must have exactly one definition')
      .toContain("export const LEGACY_DEFAULT_CLI_ID = 'claude-code'");
    expect(registry, 'the loader itself must use that constant')
      .toContain('entry.cliId ?? LEGACY_DEFAULT_CLI_ID');

    const selectionAt = ipc.indexOf('const currentSelectionKey = selectionKeyForBot(');
    expect(selectionAt, 'selection key derivation').toBeGreaterThan(0);
    const block = ipc.slice(selectionAt, ipc.indexOf(');', selectionAt));
    expect(block, 'the raw row must get the loader default')
      .toContain('LEGACY_DEFAULT_CLI_ID');
    expect(block, 'no local copy of the default literal')
      .not.toContain("'claude-code'");
  });

  it('reads the authority INSIDE the mutation gate, not before it', () => {
    // The gate serialises per bot. Reading the authority before admission lets a
    // queued request commit a proposal built from a pre-queue row: an old
    // model-only client rolls a newer runtime back (lost update) and the close
    // hook gets a stale target. Admission must come first.
    const gateAt = agentGateAt();
    const authorityAt = ipc.indexOf('let persistedBotRow');
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    expect(authorityAt, 'authority read').toBeGreaterThan(0);
    expect(
      authorityAt,
      'the authority must be read only after the mutation gate admits the request',
    ).toBeGreaterThan(gateAt);
    expect(
      authorityAt,
      'and still before the irreversible close',
    ).toBeLessThan(closeAt);
  });

  it('builds the runtime/path proposal inside the gate too', () => {
    // Re-reading the row but keeping a proposal computed outside would preserve
    // the stale runtime just the same.
    const gateAt = agentGateAt();
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    for (const marker of [
      'const currentSelectionKey = selectionKeyForBot(',
      'const deriveRuntimeForRow = (row: {',
      '({ nextRuntime, nextLegacyPath } = deriveRuntimeForRow(currentBotConfig));',
    ]) {
      const at = ipc.indexOf(marker);
      expect(at, `${marker} must exist`).toBeGreaterThan(0);
      expect(at, `${marker} must be derived inside the gate`).toBeGreaterThan(gateAt);
      expect(at, `${marker} must be derived before the close`).toBeLessThan(closeAt);
    }
  });

  it('guards the commit with a cross-process version check (CAS)', () => {
    // The mutation gate only serialises this process. The bots.json file lock is
    // NOT held across the irreversible closes, so another daemon/CLI can commit
    // inside our window. The commit must therefore re-verify the authority
    // version under the write lock and refuse rather than overwrite.
    expect(ipc, 'authority fingerprint helper').toContain('function agentAuthorityFingerprint(');
    const readAt = ipc.indexOf('let authorityVersion: string;');
    expect(readAt, 'the authority version must be captured').toBeGreaterThan(0);

    // The snapshot read must itself be inside the cross-process lock, otherwise
    // the row and its fingerprint can describe different states.
    const snapshotBlock = ipc.slice(readAt, ipc.indexOf('} catch (err) {', readAt));
    expect(snapshotBlock, 'the snapshot must be read under the file lock')
      .toContain('rmwBotEntry<');
    expect(snapshotBlock).toContain('write: false');

    // The check must run INSIDE the committing transaction, before any mutation.
    const commitAt = ipc.indexOf('}>(larkAppId, (entry) => {');
    expect(commitAt, 'commit transaction').toBeGreaterThan(0);
    const casAt = ipc.indexOf('!== authorityVersion', commitAt);
    expect(casAt, 'the commit must re-check the version').toBeGreaterThan(commitAt);
    const firstWriteAt = ipc.indexOf('entry.cliId = selected.cliId;', commitAt);
    expect(
      casAt,
      'the version check must precede every field mutation',
    ).toBeLessThan(firstWriteAt);
    // A mismatch must not write.
    const casBlock = ipc.slice(casAt, firstWriteAt);
    expect(casBlock).toContain('write: false');
    expect(casBlock).toContain("'bot_config_changed_during_switch'");
  });

  it('re-verifies the authority BEFORE the irreversible close, not only at commit', () => {
    // The commit CAS protects the file; it cannot protect sessions, because the
    // closes already ran. A concurrent writer's new runtime makes our target stale,
    // and sessions frozen on the new runtime would be closed as "mismatched".
    // Refusing to write afterwards cannot resurrect them.
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    const targetAt = ipc.indexOf('const switchTarget = {');
    const verifyAt = ipc.indexOf('const recheck = await rmwBotEntry<string>(');
    expect(verifyAt, 'a pre-close re-verify must exist').toBeGreaterThan(0);
    expect(
      verifyAt,
      'the re-verify must sit between building the target and closing with it',
    ).toBeGreaterThan(targetAt);
    expect(verifyAt, 'and strictly before the irreversible close').toBeLessThan(closeAt);

    // It must compare against the SAME version the commit CAS uses, under the lock.
    const block = ipc.slice(verifyAt, closeAt);
    expect(block).toContain('agentAuthorityFingerprint(');
    expect(block).toContain('write: false');
    expect(block, 'a mismatch must abort').toContain("error: 'bot_config_changed_during_switch'");
    // Pre-close exits must NOT pretend anything was closed.
    expect(block, 'nothing was closed yet, so no close summary').not.toContain('closeSummaryPayload');
    // An unreadable authority here must fail closed too, not fall through.
    expect(block).toContain("error: 'bot_config_unreadable'");
  });

  it('hands the close a FRESH-authority reader, not just the captured target', () => {
    // A guard on the helper alone would be false green: the helper can support
    // per-close re-verification while the route never passes it. The window this
    // closes is the close DURATION, which neither CAS covers.
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    expect(closeAt, 'close call site').toBeGreaterThan(0);
    const callBlock = ipc.slice(closeAt, ipc.indexOf(');', closeAt));
    expect(
      callBlock,
      'the close must receive a persisted-target reader as its third argument',
    ).toContain('readPersistedTarget');

    // The reader must read the AUTHORITY (disk), and must be defined before the
    // close so it cannot accidentally capture post-close state.
    const readerAt = ipc.indexOf('const readPersistedTarget = async ()');
    expect(readerAt, 'reader definition').toBeGreaterThan(0);
    expect(readerAt, 'defined before the close').toBeLessThan(closeAt);
    const readerBlock = ipc.slice(readerAt, closeAt);
    expect(readerBlock).toContain('readRawConfig(requireConfigPath())');
    expect(readerBlock).toContain('findEntryIndex(raw, larkAppId)');
    // It must RE-DERIVE the proposal through the SAME helper the commit path uses.
    // Returning the row's own config instead would call every genuinely stale
    // session "backed by disk" and skip every close — disabling the switch — and a
    // second, parallel derivation here could drift from the committed one, which is
    // the whole class of bug this handler kept hitting.
    expect(readerBlock).toContain('deriveRuntimeForRow(row)');
    // Exactly two CALL SITES (the definition reads `= (row: {`, so it is not
    // matched here): the committed proposal and the fresh re-derivation. A third
    // hand-rolled derivation is what would let them drift apart again.
    const callSites = [...ipc.matchAll(/deriveRuntimeForRow\((?!row: )/g)];
    expect(
      callSites.length,
      'the proposal and the per-close re-derivation must be the only call sites',
    ).toBe(2);
    expect(ipc, 'and there must be exactly one definition')
      .toContain('const deriveRuntimeForRow = (row: {');
    // An unreadable authority must be reported, not silently treated as "no
    // change" (which would re-open the stale-close hole).
    expect(readerBlock).toContain("'unreadable'");
  });

  it('re-justifies EVERY close against the fresh authority, in both loops', () => {
    // The registry loop and the durable-row loop both close sessions; guarding
    // only one leaves the other able to kill a session the authority still backs.
    const sm = readFileSync(
      new URL('../src/core/session-manager.ts', import.meta.url), 'utf8');
    const helperAt = sm.indexOf('const stillJustifiedByDisk = async (');
    expect(helperAt, 'per-close re-justification helper').toBeGreaterThan(0);

    // Fail closed when the authority cannot be read.
    const helperBlock = sm.slice(helperAt, sm.indexOf('  for (const ds of', helperAt));
    expect(helperBlock).toContain("=== 'unreadable'");
    expect(helperBlock).toContain('out.ok = false');

    const guards = [...sm.matchAll(/if \(!await stillJustifiedByDisk\(/g)];
    expect(
      guards.length,
      'both the registry loop and the durable-row loop must re-justify',
    ).toBe(2);
    // Each guard must sit before its close call.
    for (const g of guards) {
      const closeAt = sm.indexOf('await closeSession(', g.index!);
      expect(closeAt, 'a close must follow each guard').toBeGreaterThan(g.index!);
      const between = sm.slice(g.index!, closeAt);
      expect(between, 'the guard must skip rather than fall through').toContain('continue;');
    }
  });

  it('reports the CAS refusal as a post-close exit with the close summary', () => {
    // These closes are irreversible, so the new exit owes the same summary as the
    // other four; and it must not answer 200.
    const region = postCloseRegion();
    const at = region.indexOf("r.result.error === 'bot_config_changed_during_switch'");
    expect(at, 'CAS refusal must have its own exit').toBeGreaterThan(0);
    const block = region.slice(at, at + 600);
    expect(block, 'must carry the shared close summary').toContain('closeSummaryPayload(');
    expect(block, 'must be a conflict, not a success').toContain('409');
  });

  it('keeps the version check NARROW so unrelated edits do not reject a switch', () => {
    // Fingerprinting the whole row would make any concurrent edit (oncall
    // bindings, rename…) reject a legitimate agent switch.
    const at = ipc.indexOf('function agentAuthorityFingerprint(');
    const body = ipc.slice(at, ipc.indexOf('\n}', at));
    for (const field of [
      'cliId', 'wrapperCli', 'cliRuntime', 'cliPathOverride', 'reasoningEffort',
    ]) {
      expect(body, `${field} is derived from and must be guarded`).toContain(field);
    }
    for (const unrelated of ['oncallChats', 'larkAppSecret', 'botName', 'allowedChatGroups']) {
      expect(body, `${unrelated} must NOT widen the check`).not.toContain(unrelated);
    }
  });

  it('FAILS CLOSED when the authority cannot be read', () => {
    // Swallowing the read error and deferring to the locked backstop means the
    // irreversible closes run first, so a request that never commits still tears
    // down live sessions.
    const authorityAt = ipc.indexOf('let persistedBotRow');
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    const region = ipc.slice(authorityAt, closeAt);
    expect(region, 'read failure must return, not continue')
      .toContain("error: 'bot_config_unreadable'");
    // A missing row is reported by rmwBotEntry as `bot_not_in_config`; the handler
    // must surface that reason instead of continuing into the closes.
    expect(region, 'a missing row must also refuse before the closes')
      .toContain('error: snapshot.reason');
  });

  it('KEEPS the in-transaction check as a backstop', () => {
    // Only the transactional copy sees the row under the write lock. Removing it
    // would trade one race for another, so the preflight is defence in depth.
    expect(postCloseRegion()).toContain('codexModelSupportsReasoningEffort(');
  });

  it('gives every post-close failure exit the close summary', () => {
    // Exhaustive rather than a fixed count: the closes are irreversible, so any
    // exit after them is the only report of a surviving remote session.
    const region = postCloseRegion();
    const exits = [...region.matchAll(/return jsonRes\(res, (400|409|500)/g)];
    expect(exits.length, 'post-close failure exits').toBeGreaterThanOrEqual(4);
    const summaries = [...region.matchAll(/closeSummaryPayload\(/g)];
    expect(
      summaries.length,
      'each post-close failure exit must carry closeSummaryPayload',
    ).toBeGreaterThanOrEqual(exits.length);

    // The single shape is only worth having if it is COMPLETE: the operator needs
    // the surviving task ids, not just a count. Pin all four fields at the source
    // so a future edit cannot quietly drop one for every exit at once.
    const payloadAt = ipc.indexOf('const closeSummaryPayload = (');
    expect(payloadAt, 'closeSummaryPayload definition').toBeGreaterThan(0);
    const payload = ipc.slice(payloadAt, ipc.indexOf('});', payloadAt));
    for (const field of [
      'closedMismatchedSessions',
      'closedMismatchedResidual',
      'closedMismatchedFailed',
      'closedMismatchedResidualTaskIds',
    ]) {
      expect(payload, `${field} must be reported by every post-close exit`).toContain(field);
    }
  });
});

describe('agent switch — the client renders any close-summary response', () => {
  it('detects post-close responses by FIELD, never by an error-code list', () => {
    expect(page).toContain('function carriesAgentSwitchCloseSummary(');
    const helper = page.slice(
      page.indexOf('function carriesAgentSwitchCloseSummary('),
      page.indexOf('function parseAgentSwitchSummary('),
    );
    // Keyed on the summary fields the server always attaches.
    for (const field of [
      'closedMismatchedSessions',
      'closedMismatchedFailed',
      'closedMismatchedResidual',
      'closedMismatchedResidualTaskIds',
    ]) {
      expect(helper, `${field} must be recognised`).toContain(field);
    }
  });

  it('has no `aborted` branch keyed on specific error codes', () => {
    // This is the regression itself: enumerating codes is what dropped the fourth
    // exit's residual ids. Every `aborted` decision must go through the helper.
    const abortedDecisions = [...page.matchAll(/const aborted = ([^;]+);/g)];
    expect(abortedDecisions.length, 'aborted decisions found').toBeGreaterThanOrEqual(2);
    for (const [, expr] of abortedDecisions) {
      expect(expr, 'aborted must be field-driven').toContain('carriesAgentSwitchCloseSummary');
      expect(expr, 'aborted must not enumerate error codes')
        .not.toMatch(/agent_switch_(close|commit)_failed/);
    }
  });

  it('still renders counts and residual ids on that branch', () => {
    // Detecting the state is useless if the ids are not shown.
    expect(page).toContain('residualIdText(abortSummary, tr)');
  });
});
