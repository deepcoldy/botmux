/**
 * Guards the per-turn model/reasoningEffort consumption chain (adapter args /
 * thread config) with source-level checks where worker.ts has no public seam.
 */
import { describe, it, expect, vi } from 'bun:test';
import { readFileSync } from 'node:fs';

// codex-app buildArgs resolves the codex binary via resolveCommand; return the
// path as-is so we can assert the emitted flags without shelling out.
vi.mock('../src/adapters/cli/registry.js', async (orig) => {
  const actual = await orig<typeof import('../src/adapters/cli/registry.js')>();
  return { ...actual, resolveCommand: (bin: string) => bin };
});

import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createCodexAppAdapter } from '../src/adapters/cli/codex-app.js';

const BASE = { sessionId: 's1', resume: false, workingDir: '/tmp' } as const;

describe('codex adapter buildArgs — reasoningEffort injection', () => {
  it('injects -c model_reasoning_effort verbatim (xhigh NOT downgraded)', () => {
    const args = createCodexAdapter('/usr/bin/codex').buildArgs({ ...BASE, reasoningEffort: 'xhigh' });
    const i = args.indexOf('model_reasoning_effort="xhigh"');
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe('-c');
    // must not appear as high — that would be the removed downgrade
    expect(args.join(' ')).not.toContain('model_reasoning_effort="high"');
  });

  it('passes each effort level through unchanged', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const) {
      const args = createCodexAdapter('/usr/bin/codex').buildArgs({ ...BASE, reasoningEffort: e });
      expect(args.join(' ')).toContain(`model_reasoning_effort="${e}"`);
    }
  });

  it('omits the -c effort flag when no effort is given', () => {
    const args = createCodexAdapter('/usr/bin/codex').buildArgs({ ...BASE });
    expect(args.join(' ')).not.toContain('model_reasoning_effort');
  });

  it('injects --model when provided', () => {
    const args = createCodexAdapter('/usr/bin/codex').buildArgs({ ...BASE, model: 'gpt-5.6-terra' });
    const i = args.indexOf('gpt-5.6-terra');
    expect(args[i - 1]).toBe('--model');
  });
});

describe('codex-app adapter buildArgs — runner flags', () => {
  it('emits --model and --reasoning-effort (xhigh verbatim) for the runner', () => {
    const args = createCodexAppAdapter('/usr/bin/codex').buildArgs({ ...BASE, model: 'gpt-5.6-terra', reasoningEffort: 'xhigh' });
    const mi = args.indexOf('--model');
    expect(args[mi + 1]).toBe('gpt-5.6-terra');
    const ei = args.indexOf('--reasoning-effort');
    expect(args[ei + 1]).toBe('xhigh');
  });

  it('passes each effort level to the runner unchanged', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const) {
      const args = createCodexAppAdapter('/usr/bin/codex').buildArgs({ ...BASE, reasoningEffort: e });
      const i = args.indexOf('--reasoning-effort');
      expect(args[i + 1]).toBe(e);
    }
  });

  it('omits both flags when neither is given', () => {
    const args = createCodexAppAdapter('/usr/bin/codex').buildArgs({ ...BASE });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--reasoning-effort');
  });
});

describe('worker → CodexRpcEngine effort wiring (source lock)', () => {
  // Source-wiring guard: the RPC engine unit test constructs the engine directly,
  // so it would still pass if worker.ts stopped forwarding reasoningEffort. This
  // locks the actual construction site — deleting the line fails here, catching
  // exactly the regression codex caught last round (effort never reaching the
  // real execution engine).
  it('worker constructs CodexRpcEngine with reasoningEffort: cfg.reasoningEffort', () => {
    const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const ctor = source.indexOf('new CodexRpcEngine({');
    expect(ctor).toBeGreaterThan(0);
    const end = source.indexOf('});', ctor);
    const body = source.slice(ctor, end);
    expect(body).toContain('model: cfg.model');
    expect(body).toContain('reasoningEffort: cfg.reasoningEffort');
  });

  it('freezes the per-Bot default onto a newly created session for supported CLIs', () => {
    const source = readFileSync(new URL('../src/core/worker-pool.ts', import.meta.url), 'utf8');
    expect(source).toContain('ds.session.reasoningEffort = isConfigurableReasoningCliId(ds.session.cliId)');
    expect(source).toContain('? ds.session.reasoningEffort ?? botCfg.reasoningEffort');
    expect(source).toContain(': undefined;');
    const frozenBranch = source.indexOf('if (!ds.session.agentFrozen)');
    // The capability guard is checked against the model THIS spawn resolves
    // (`model`, from resolveSessionLaunchModel), not the session's recorded one:
    // the model is no longer frozen, and a per-trigger override never lands in
    // the record — judging support by the record would use the wrong model.
    const compatibilityGuard = source.indexOf('cliModelSupportsReasoningEffort(ds.session.cliId, model, ds.session.reasoningEffort)');
    const returnConfig = source.indexOf('return {', frozenBranch);
    expect(compatibilityGuard).toBeGreaterThan(frozenBranch);
    expect(compatibilityGuard).toBeLessThan(returnConfig);
  });
});
