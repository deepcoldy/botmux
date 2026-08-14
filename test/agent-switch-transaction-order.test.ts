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

    // Same source as the transaction: the on-disk row.
    expect(preflight).toContain('readRawConfig(requireConfigPath())');
    expect(preflight).toContain('findEntryIndex(raw, larkAppId)');
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

  it('FAILS CLOSED when the authority cannot be read', () => {
    // Swallowing the read error and deferring to the locked backstop means the
    // irreversible closes run first, so a request that never commits still tears
    // down live sessions.
    const authorityAt = ipc.indexOf('let persistedBotRow');
    const closeAt = ipc.indexOf('await agentSwitchCloseHook.run(');
    const region = ipc.slice(authorityAt, closeAt);
    expect(region, 'read failure must return, not continue')
      .toContain("error: 'bot_config_unreadable'");
    expect(region, 'a missing row must also refuse before the closes')
      .toContain("error: 'bot_not_in_config'");
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
