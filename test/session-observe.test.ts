import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  OBSERVE_SCHEMA_VERSION,
  normalizeSessionRow,
  type RawSessionRow,
} from '../src/services/session-observe.js';
import type { ObserveSession } from '../src/services/session-observe.js';
import type { ObserveFetchOptions } from '../src/services/session-observe-fetch.js';

expectTypeOf<ObserveSession['backend']['adopted']>().toEqualTypeOf<boolean | 'unknown'>();
expectTypeOf<ObserveSession['parkedOrSuspended']>().toEqualTypeOf<boolean | 'unknown'>();
expectTypeOf<ObserveSession['closed']>().toEqualTypeOf<boolean | 'unknown'>();
expectTypeOf<keyof ObserveFetchOptions>().toEqualTypeOf<'larkAppId' | 'includeRaw'>();

const OBSERVED_AT = 1_700_000_000_000;

function makeRow(overrides: Partial<RawSessionRow>): RawSessionRow {
  return {
    sessionId: 's_1',
    larkAppId: 'cli_app_1',
    chatId: 'oc_1',
    rootMessageId: 'om_1',
    scope: 'thread',
    botName: 'bot-x',
    cliId: 'codex',
    runtimeId: 'codex',
    runtimeDisplayName: 'Codex',
    cliVersion: '1.0.0',
    backendType: 'pty',
    workerPid: 1234,
    adopt: false,
    status: 'idle',
    queued: false,
    workingDir: '/tmp/repo',
    lastMessageAt: OBSERVED_AT - 5_000,
    feishuChatLink: 'https://feishu/oc_1',
    ...overrides,
  };
}

describe('session-observe normalizer', () => {
  it('maps a working active row to alive/working, queued=false', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'working', queued: false, backendType: 'tmux', workerPid: 42 }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.schemaVersion).toBe(OBSERVE_SCHEMA_VERSION);
    expect(observe.observedAt).toBe(OBSERVED_AT);
    expect(observe.liveness).toBe('alive');
    expect(observe.turn).toBe('working');
    expect(observe.phase).toBe('unknown');
    expect(observe.queued).toBe(false);
    expect(observe.parkedOrSuspended).toBe(false);
    expect(observe.closed).toBe(false);
    expect(observe.backend.type).toBe('tmux');
    expect(observe.backend.workerPid).toBe(42);
    expect(observe.backend.adopted).toBe(false);
    expect(observe.probe).toEqual({ status: 'ok', source: 'daemon-ipc' });
    expect(observe.rawStatus).toBe('working');
    expect(observe.raw).toBeUndefined();
  });

  it('maps an idle row to alive/idle', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'idle', queued: false }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.liveness).toBe('alive');
    expect(observe.turn).toBe('idle');
  });

  it('maps a starting row to alive/starting (worker up, no screen status yet)', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'starting' }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.liveness).toBe('alive');
    expect(observe.turn).toBe('starting');
  });

  it('maps a dormant row (cap-suspend / park / unproven teardown) to not_running/unknown turn', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'dormant', workerPid: undefined, backendType: 'tmux' }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.liveness).toBe('not_running');
    expect(observe.turn).toBe('unknown');
    expect(observe.phase).toBe('unknown');
    expect(observe.parkedOrSuspended).toBe(true);
    expect(observe.closed).toBe(false);
    expect(observe.rawStatus).toBe('dormant');
  });

  it('maps a closed row to closed/unknown-turn', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'closed' }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.liveness).toBe('closed');
    expect(observe.turn).toBe('unknown');
    expect(observe.closed).toBe(true);
    expect(observe.parkedOrSuspended).toBe(false);
  });

  it('projects a queued (待办) row as not running and parked', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'idle', queued: true, pendingRepo: true }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.liveness).toBe('not_running');
    expect(observe.turn).toBe('idle');
    expect(observe.queued).toBe(true);
    expect(observe.pendingRepo).toBe(true);
    expect(observe.parkedOrSuspended).toBe(true);
  });

  it('keeps runtime facts unknown for a future unrecognized status', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'paused', queued: undefined, adopt: undefined }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.liveness).toBe('unknown');
    expect(observe.turn).toBe('unknown');
    expect(observe.queued).toBe('unknown');
    expect(observe.closed).toBe('unknown');
    expect(observe.parkedOrSuspended).toBe('unknown');
    expect(observe.backend.adopted).toBe('unknown');
  });

  it('keeps boolean facts unknown when a successful row omits their evidence', () => {
    const observe = normalizeSessionRow(
      { sessionId: 's_partial' },
      { observedAt: OBSERVED_AT },
    );
    expect(observe.closed).toBe('unknown');
    expect(observe.parkedOrSuspended).toBe('unknown');
    expect(observe.backend.adopted).toBe('unknown');
  });

  it('carries agentAttention / tuiPromptActive / workingDir / lastActivityAt through', () => {
    const observe = normalizeSessionRow(
      makeRow({
        status: 'idle',
        tuiPromptActive: true,
        agentAttention: { kind: 'blocked', reason: 'ci failed', at: OBSERVED_AT - 1_000 },
      }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.tuiPromptActive).toBe(true);
    expect(observe.attention).toEqual({ kind: 'blocked', reason: 'ci failed', at: OBSERVED_AT - 1_000 });
    expect(observe.workingDirectory).toBe('/tmp/repo');
    expect(observe.lastActivityAt).toBe(OBSERVED_AT - 5_000);
  });

  it('carries adopt/adoptCliPid but does not synthesize workerPid when absent', () => {
    const observe = normalizeSessionRow(
      makeRow({ status: 'working', adopt: true, adoptCliPid: 999, workerPid: undefined }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.backend.adopted).toBe(true);
    expect(observe.backend.adoptCliPid).toBe(999);
    expect(observe.backend.workerPid).toBeUndefined();
  });

  it('never surfaces phase other than "unknown"', () => {
    for (const status of ['working', 'idle', 'starting', 'analyzing', 'dormant', 'closed', 'stalled']) {
      const observe = normalizeSessionRow(
        makeRow({ status }),
        { observedAt: OBSERVED_AT },
      );
      expect(observe.phase).toBe('unknown');
    }
  });

  it('honors caller-provided probe status (e.g. not_found for session-level miss)', () => {
    const observe = normalizeSessionRow(
      { sessionId: 's_missing', status: 'working', queued: false, adopt: true },
      {
        observedAt: OBSERVED_AT,
        probe: { status: 'not_found', source: 'daemon-ipc', larkAppId: 'cli_app_1' },
      },
    );
    expect(observe.liveness).toBe('unknown');
    expect(observe.turn).toBe('unknown');
    expect(observe.queued).toBe('unknown');
    expect(observe.backend.adopted).toBe('unknown');
    expect(observe.parkedOrSuspended).toBe('unknown');
    expect(observe.closed).toBe('unknown');
    expect(observe.probe).toEqual({ status: 'not_found', source: 'daemon-ipc', larkAppId: 'cli_app_1' });
    expect(observe.identity.sessionId).toBe('s_missing');
  });

  it('does not treat cliId="unknown" as a real cli identity', () => {
    const observe = normalizeSessionRow(
      makeRow({ cliId: 'unknown' }),
      { observedAt: OBSERVED_AT },
    );
    expect(observe.cli.id).toBeUndefined();
    // runtimeId is still surfaced because it reflects the frozen distribution
    expect(observe.cli.runtimeId).toBe('codex');
  });

  it('embeds raw when includeRaw is set (diagnostic seam only)', () => {
    const row = makeRow({ status: 'idle' });
    const observe = normalizeSessionRow(row, { observedAt: OBSERVED_AT, includeRaw: true });
    expect(observe.raw).toBe(row);
  });
});
