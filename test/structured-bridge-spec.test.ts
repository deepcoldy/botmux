/**
 * StructuredBridgeSpec — the adapter-declared capability the worker's transcript
 * bridge is driven by (drain / locate / spawn + adopt attach policy).
 */
import { traexSessionIdFromRolloutPath } from '../src/services/traex-transcript.js';
import { codexSessionIdFromRolloutPath } from '../src/services/codex-transcript.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeSpecFor, createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { resolveFileBridgePath } from '../src/services/file-bridge-path.js';
import { STRUCTURED_BRIDGE_ALWAYS_CLI_IDS, STRUCTURED_BRIDGE_ZERO_PROMPT_CLI_IDS, STRUCTURED_BRIDGE_ADOPT_CLI_IDS } from '../src/services/structured-bridge-clis.js';
import type { CliId } from '../src/adapters/cli/types.js';

// Absolute fake binary path: resolveCommand returns absolute paths verbatim, so
// constructing pi / oh-my-pi (which resolve eagerly) never shells out.
const FAKE_BIN = '/usr/local/bin/fake-cli';
const FILE_BACKED: CliId[] = ['codex', 'traex', 'coco', 'cursor', 'antigravity', 'pi', 'oh-my-pi', 'ebsd', 'grok'];

describe('bridgeSpecFor (static lookup) vs adapter.bridgeSpec', () => {
  it.each(FILE_BACKED)('%s: the adapter instance exposes exactly the spec the registry looks up', cliId => {
    const spec = bridgeSpecFor(cliId);
    expect(spec).toBeDefined();
    expect(createCliAdapterSync(cliId, FAKE_BIN).bridgeSpec).toBe(spec);
  });

  it('SQLite-backed hermes / mtr and non-bridge CLIs declare no spec', () => {
    for (const id of ['hermes', 'mtr', 'claude-code', 'gemini', 'codex-app', 'mira'] as CliId[]) {
      expect(bridgeSpecFor(id)).toBeUndefined();
      expect(createCliAdapterSync(id, FAKE_BIN).bridgeSpec).toBeUndefined();
    }
    expect(bridgeSpecFor(undefined)).toBeUndefined();
    expect(bridgeSpecFor('not-a-cli')).toBeUndefined();
  });

  it('every file-backed id in the structured-bridge allowlists has a spec, and nothing else does', () => {
    const allowlisted = new Set<string>([
      ...STRUCTURED_BRIDGE_ALWAYS_CLI_IDS,
      ...STRUCTURED_BRIDGE_ZERO_PROMPT_CLI_IDS,
    ]);
    // hermes / mtr are SQLite-backed (dedicated worker paths).
    const withSpec = [...allowlisted].filter(id => bridgeSpecFor(id));
    expect(new Set(withSpec)).toEqual(new Set(FILE_BACKED));
    for (const id of allowlisted) {
      if (id === 'hermes' || id === 'mtr') continue;
      expect(bridgeSpecFor(id), id).toBeDefined();
    }
  });

  it('adopt policy is declared only for CLIs the daemon forwards adopt pid/cwd/sid for', () => {
    const adoptForwarding = new Set<string>(STRUCTURED_BRIDGE_ADOPT_CLI_IDS);
    for (const id of FILE_BACKED) {
      if (bridgeSpecFor(id)?.adopt) expect(adoptForwarding.has(id), id).toBe(true);
    }
  });

  it('pins the per-CLI differences that must not be flattened', () => {
    // codex keeps App Server share + state; traex shares the rollout shape but not either.
    expect(bridgeSpecFor('codex')).toMatchObject({ stateCommit: 'drain', spawn: { appServerShare: true, baseline: 'resume-aware' } });
    expect(bridgeSpecFor('codex')?.adopt).toBeUndefined();
    expect(bridgeSpecFor('traex')?.stateCommit).toBeUndefined();
    expect(bridgeSpecFor('traex')?.spawn?.appServerShare).toBeUndefined();
    expect(bridgeSpecFor('traex')?.adopt).toMatchObject({ attach: 'split-live' });
    // The pid-probed id must come from traex's own (segment-aware) parser.
    // A resumed-segment rollout (#1854): the codex parser cannot read it, so
    // persisting through it silently dropped the session id on pid-probe adopt.
    // This assertion is the load-bearing guard for the intentionally strict,
    // zero-production-caller codexSessionIdFromRolloutPath — see its doc block
    // in src/services/codex-transcript.ts for why it must not be deleted or
    // relaxed (the same shape is a Codex generation, read only via
    // codexGenerationSessionIdFromRolloutPath on Codex-scoped paths).
    const sid = '00000000-0000-7000-8000-000000000001';
    const segmented = `/h/.trae/sessions/2026/10/14/rollout-2026-10-14T08-00-00-${sid}_00000000-0000-7000-8000-000000000099.jsonl`;
    expect(codexSessionIdFromRolloutPath(segmented)).toBeUndefined();
    expect(traexSessionIdFromRolloutPath(segmented)).toBe(sid);
    expect(bridgeSpecFor('traex')?.adopt?.pidProbedSessionId?.(segmented)).toBe(sid);
    // antigravity: held final committed on ingest only, birth-aware baseline, zero-prompt only, no adopt.
    expect(bridgeSpecFor('antigravity')).toMatchObject({ stateCommit: 'ingest', spawn: { baseline: 'birth-aware', zeroPromptOnly: true } });
    expect(bridgeSpecFor('antigravity')?.adopt).toBeUndefined();
    // cursor: no per-event timestamps → byte-offset baseline on adopt; zero-prompt only on spawn.
    expect(bridgeSpecFor('cursor')).toMatchObject({ adopt: { attach: 'baseline-skip-tail' }, spawn: { zeroPromptOnly: true } });
    // id-addressed isolated sessions (no pid discovery) fall back to the adapter session id.
    for (const id of ['oh-my-pi', 'ebsd'] as const) {
      expect(bridgeSpecFor(id)?.locate.byPid).toBeUndefined();
      expect(bridgeSpecFor(id)?.spawn?.sessionId).toBe('cli-or-adapter');
    }
    // coco keeps its dedicated spawn/adopt branches.
    expect(bridgeSpecFor('coco')?.spawn).toBeUndefined();
    expect(bridgeSpecFor('coco')?.adopt).toBeUndefined();
  });
});

describe('spec.drain threads driver state', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bridge-spec-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it.each(['oh-my-pi', 'ebsd', 'antigravity'] as const)('%s: drains a missing file without throwing and returns a state object', id => {
    const spec = bridgeSpecFor(id)!;
    const result = spec.drain(join(dir, 'nope.jsonl'), 0, { adoptMode: false, state: undefined });
    expect(result.events).toEqual([]);
    expect(result.state).toBeDefined();
  });

  it('stateless drivers (traex / cursor / pi / grok / coco) return no state to commit', () => {
    for (const id of ['traex', 'cursor', 'pi', 'grok', 'coco'] as const) {
      const spec = bridgeSpecFor(id)!;
      expect(spec.stateCommit, id).toBeUndefined();
      expect(spec.drain(join(dir, 'nope.jsonl'), 0, { adoptMode: false, state: undefined }).state, id).toBeUndefined();
    }
  });
});

describe('resolveFileBridgePath delegates to spec.locate (sid first, then pid)', () => {
  it('returns undefined for CLIs without a spec and for empty ids', () => {
    expect(resolveFileBridgePath(undefined, { sessionId: 'x' })).toBeUndefined();
    expect(resolveFileBridgePath('hermes', { sessionId: 'x', pid: 123 })).toBeUndefined();
    expect(resolveFileBridgePath('claude-code', { sessionId: 'x' })).toBeUndefined();
  });

  it('prefers the session-id hit and only consults the pid when the sid misses', () => {
    const byPid = vi.fn(() => '/by/pid');
    const spec = bridgeSpecFor('cursor')!;
    const bySid = vi.spyOn(spec.locate, 'bySessionId');
    const pidSpy = vi.spyOn(spec.locate, 'byPid').mockImplementation(byPid);
    try {
      bySid.mockReturnValueOnce('/by/sid');
      expect(resolveFileBridgePath('cursor', { sessionId: 's', pid: 42 })).toBe('/by/sid');
      expect(pidSpy).not.toHaveBeenCalled();
      bySid.mockReturnValueOnce(undefined);
      expect(resolveFileBridgePath('cursor', { sessionId: 's', pid: 42 })).toBe('/by/pid');
      expect(pidSpy).toHaveBeenCalledWith(42);
      // invalid pids never reach the locator
      pidSpy.mockClear();
      expect(resolveFileBridgePath('cursor', { pid: 0 })).toBeUndefined();
      expect(resolveFileBridgePath('cursor', { pid: 1.5 })).toBeUndefined();
      expect(pidSpy).not.toHaveBeenCalled();
    } finally {
      bySid.mockRestore();
      pidSpy.mockRestore();
    }
  });

  it('oh-my-pi and ebsd are id-addressed only: a pid never resolves a path', () => {
    expect(resolveFileBridgePath('oh-my-pi', { pid: 4242 })).toBeUndefined();
    expect(resolveFileBridgePath('ebsd', { pid: 4242 })).toBeUndefined();
  });
});
