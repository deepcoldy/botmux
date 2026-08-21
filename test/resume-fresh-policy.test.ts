/**
 * Resume-without-cliSessionId → fresh-session policy.
 *
 * Adapters whose buildArgs can only resume a PRECISE cliSessionId (cursor /
 * copilot / kimi — no --continue/latest fallback, which would risk loading a
 * SIBLING session's conversation) declare `resumeRequiresCliSessionId`. This
 * file covers:
 *
 *   1. `resumeStartsFresh` — the shared predicate upper layers (closed card,
 *      resume receipt) use to distinguish "route reactivated" from "CLI
 *      history restored".
 *   2. Worker source-lock — resume-without-id is routed through the existing
 *      fresh-demotion branch (effectiveResume=false + user_notify), so the
 *      cold-recovery path is observable instead of silently launching a blank
 *      session while the UI claims history is back.
 *   3. Card-handler source-lock — the resume receipt picks the fresh variant.
 *
 * Run: pnpm vitest run test/resume-fresh-policy.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { resumeStartsFresh } from '../src/services/resume-fresh-policy.js';

describe('resumeStartsFresh', () => {
  it('copilot / kimi / cursor without a persisted cliSessionId start fresh', () => {
    expect(resumeStartsFresh({ cliId: 'copilot' })).toBe(true);
    expect(resumeStartsFresh({ cliId: 'kimi' })).toBe(true);
    expect(resumeStartsFresh({ cliId: 'cursor' })).toBe(true);
  });

  it('copilot / kimi / cursor WITH a cliSessionId resume precisely (not fresh)', () => {
    expect(resumeStartsFresh({ cliId: 'copilot', cliSessionId: 'sess-1' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'kimi', cliSessionId: 'sess-1' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'cursor', cliSessionId: 'chat-1' })).toBe(false);
  });

  it('adapters that can always resume (botmux sessionId is the CLI id) never start fresh', () => {
    expect(resumeStartsFresh({ cliId: 'claude-code' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'grok' })).toBe(false);
    expect(resumeStartsFresh({ cliId: 'hermes' })).toBe(false);
  });

  it('adapters that ignore resume entirely (gemini) are not flagged', () => {
    expect(resumeStartsFresh({ cliId: 'gemini' })).toBe(false);
  });

  it('missing cliId / unknown cliId → false (fail safe, no false "history lost" claim)', () => {
    expect(resumeStartsFresh({})).toBe(false);
    expect(resumeStartsFresh({ cliId: 'not-a-real-cli' })).toBe(false);
  });
});

// ─── Worker wiring (source lock) ────────────────────────────────────────────
//
// spawnCli is not exported for unit testing; the repo convention for its
// internal wiring is source-lock tests (see config-dir.test.ts). These assert
// the missing-exact-id case is routed through the EXISTING fresh-demotion
// branch — the one that flips effectiveResume=false and emits the
// "历史会话无法恢复，已为你新起一个干净会话" user_notify — instead of leaving
// effectiveResume=true while the adapter silently launches a blank session.
describe('worker spawnCli resume demotion (source lock)', () => {
  const workerSource = readFileSync(resolvePath('src/worker.ts'), 'utf8');

  it('declares the missing-exact-id tier from the adapter capability flag', () => {
    expect(workerSource).toContain('cliAdapter.resumeRequiresCliSessionId === true');
    expect(workerSource).toContain('const missingExactResumeId');
  });

  it('feeds the tier into fallBackToFresh (not a standalone side branch)', () => {
    const start = workerSource.indexOf('const fallBackToFresh =');
    expect(start).toBeGreaterThan(-1);
    const block = workerSource.slice(start, start + 400);
    expect(block).toContain('missingExactResumeId');
  });

  it('demotes effectiveResume + emits the existing fresh-demotion user_notify', () => {
    // The tier must land inside the `if (fallBackToFresh)` block that already
    // drops resume and notifies — not a parallel silent path.
    const fbStart = workerSource.indexOf('if (fallBackToFresh) {');
    expect(fbStart).toBeGreaterThan(-1);
    const block = workerSource.slice(fbStart, fbStart + 2200);
    expect(block).toContain('effectiveResume = false;');
    expect(block).toContain('effectiveCliSessionId = undefined;');
    expect(block).toContain('resumeFallbackNotified');
    expect(block).toContain('user_notify');
    expect(block).toContain('新起一个干净会话');
  });

  it('gives the missing-id case its own reason in the notice', () => {
    expect(workerSource).toContain('no persisted CLI session id');
  });

  it('never demotes when reattaching to a live persistent pane (no context is lost)', () => {
    const start = workerSource.indexOf('const missingExactResumeId');
    expect(start).toBeGreaterThan(-1);
    const block = workerSource.slice(start, start + 400);
    expect(block).toContain('!willReattachPersistent');
  });
});

// ─── Card copy wiring (source lock) ─────────────────────────────────────────
describe('resume copy distinction (source lock)', () => {
  it('card-handler picks the fresh receipt variant via resumeStartsFresh', () => {
    const source = readFileSync(resolvePath('src/im/lark/card-handler.ts'), 'utf8');
    expect(source).toContain("t('card.action.resume_success_fresh'");
    expect(source).toContain('resumeStartsFresh(result.ds.session)');
  });

  it('closed-session-card passes the fresh flag into the card builder', () => {
    const source = readFileSync(resolvePath('src/core/closed-session-card.ts'), 'utf8');
    expect(source).toContain('resumeStartsFresh({ cliId: closedCliId, cliSessionId: ds.session.cliSessionId })');
  });

  it('card-builder renders the fresh note instead of the generic resume note', () => {
    const source = readFileSync(resolvePath('src/im/lark/card-builder.ts'), 'utf8');
    expect(source).toContain('resumeStartsFresh?: boolean');
    expect(source).toContain("t('card.body.resume_starts_fresh'");
  });
});
