// Behavior tests for the session-observe façade.
//
// These tests never hit a real daemon: `discover` and `fetch` are injected. The
// tests pin `now` so the emitted `observedAt` is deterministic. Each case
// pretends to be one worker/session scenario (working, dormant, closed,
// queued, unknown status, unauthorized, unreachable, not_found, daemon offline,
// mixed pty/tmux, mixed CLI adapters).

import { describe, expect, it } from 'vitest';
import {
  fetchObserveSession,
  fetchObserveSnapshot,
  type DaemonIpcFetch,
} from '../src/services/session-observe-fetch-internal.js';
import type { OnlineDaemonInfo } from '../src/utils/daemon-discovery.js';
import type { RawSessionRow } from '../src/services/session-observe.js';

const OBSERVED_AT = 1_700_000_000_000;

function makeDaemon(overrides: Partial<OnlineDaemonInfo> = {}): OnlineDaemonInfo {
  return {
    larkAppId: 'cli_app_alpha',
    ipcPort: 4310,
    botName: 'alpha-bot',
    cliId: 'codex',
    pid: 12345,
    lastHeartbeat: OBSERVED_AT - 1000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function baseRow(overrides: Partial<RawSessionRow>): RawSessionRow {
  return {
    sessionId: 's_alpha_1',
    larkAppId: 'cli_app_alpha',
    chatId: 'oc_x',
    rootMessageId: 'om_x',
    scope: 'thread',
    botName: 'alpha-bot',
    cliId: 'codex',
    runtimeId: 'codex',
    runtimeDisplayName: 'Codex',
    cliVersion: '2.0.0',
    backendType: 'pty',
    workerPid: 999,
    adopt: false,
    status: 'idle',
    queued: false,
    workingDir: '/repo/alpha',
    lastMessageAt: OBSERVED_AT - 2_000,
    ...overrides,
  };
}

describe('fetchObserveSnapshot', () => {
  it('normalizes SessionRow across pty + tmux and two CLI adapters', async () => {
    const daemon = makeDaemon();
    const fetch: DaemonIpcFetch = async (port, path) => {
      expect(port).toBe(4310);
      expect(path).toBe('/api/sessions');
      return jsonResponse({
        sessions: [
          baseRow({ status: 'working', cliId: 'codex', backendType: 'pty', queued: false }),
          baseRow({
            sessionId: 's_alpha_2', cliId: 'claude-code', backendType: 'tmux',
            status: 'idle', queued: true, pendingRepo: true, workerPid: undefined,
          }),
          baseRow({
            sessionId: 's_alpha_3', cliId: 'gemini', status: 'dormant',
            backendType: 'pty', workerPid: undefined, queued: false,
          }),
          baseRow({
            sessionId: 's_alpha_4', cliId: 'codex', status: 'closed',
            backendType: 'pty', workerPid: undefined, queued: false,
          }),
        ],
      });
    };
    const snapshot = await fetchObserveSnapshot({
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [daemon],
      fetch,
    });
    expect(snapshot.observedAt).toBe(OBSERVED_AT);
    expect(snapshot.daemons).toHaveLength(1);
    const envelope = snapshot.daemons[0]!;
    expect(envelope.probe.status).toBe('ok');
    expect(envelope.sessions.map(s => [s.identity.sessionId, s.liveness, s.turn, s.queued])).toEqual([
      ['s_alpha_1', 'alive', 'working', false],
      ['s_alpha_2', 'not_running', 'idle', true],
      ['s_alpha_3', 'not_running', 'unknown', false],
      ['s_alpha_4', 'closed', 'unknown', false],
    ]);
    // CLI adapter identity survives the projection
    expect(envelope.sessions.map(s => s.cli.id)).toEqual(['codex', 'claude-code', 'gemini', 'codex']);
    // Backend type is preserved verbatim
    expect(envelope.sessions.map(s => s.backend.type)).toEqual(['pty', 'tmux', 'pty', 'pty']);
    // phase is universally unknown by contract
    for (const s of envelope.sessions) expect(s.phase).toBe('unknown');
  });

  it('marks daemon_offline when the requested larkAppId is not in discovery', async () => {
    const snapshot = await fetchObserveSnapshot({
      larkAppId: 'cli_ghost',
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch: async () => { throw new Error('should not fetch'); },
    });
    expect(snapshot.daemons).toEqual([expect.objectContaining({
      larkAppId: 'cli_ghost',
      sessions: [],
      probe: { status: 'daemon_offline', source: 'daemon-ipc', larkAppId: 'cli_ghost' },
    })]);
  });

  it('surfaces unauthorized without any session data on 403', async () => {
    const fetch: DaemonIpcFetch = async () => new Response('forbidden', { status: 403 });
    const snapshot = await fetchObserveSnapshot({
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch,
    });
    const env = snapshot.daemons[0]!;
    expect(env.probe.status).toBe('unauthorized');
    expect(env.sessions).toEqual([]);
  });

  it('does not fall back to cached rows when IPC times out', async () => {
    const fetch: DaemonIpcFetch = () => new Promise<Response>(() => {/* hang */});
    const snapshot = await fetchObserveSnapshot({
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch,
      timeoutMs: 10,
    });
    const env = snapshot.daemons[0]!;
    expect(env.probe.status).toBe('unreachable');
    expect(env.probe.error).toMatch(/timeout/);
    expect(env.sessions).toEqual([]);
  });

  it('times out while reading a stalled response body', async () => {
    let cancelled = false;
    const fetch: DaemonIpcFetch = async (_port, _path, init) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            cancelled = true;
            controller.error(new Error('aborted'));
          });
        },
      });
      return new Response(body, { status: 200 });
    };
    const snapshot = await fetchObserveSnapshot({
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch,
      timeoutMs: 10,
    });
    expect(snapshot.daemons[0]!.probe.status).toBe('unreachable');
    expect(snapshot.daemons[0]!.probe.error).toMatch(/timeout/);
    expect(cancelled).toBe(true);
  });

  it('rejects a malformed body as unreachable rather than inferring structure', async () => {
    const fetch: DaemonIpcFetch = async () => jsonResponse({ nope: 'not the right shape' });
    const snapshot = await fetchObserveSnapshot({
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch,
    });
    expect(snapshot.daemons[0]!.probe.status).toBe('unreachable');
    expect(snapshot.daemons[0]!.probe.error).toBe('malformed_body');
  });

  it('aggregates two online daemons independently', async () => {
    const alpha = makeDaemon();
    const beta = makeDaemon({ larkAppId: 'cli_app_beta', ipcPort: 4311, cliId: 'claude-code' });
    const fetch: DaemonIpcFetch = async (port) => {
      if (port === alpha.ipcPort) return jsonResponse({ sessions: [baseRow({ status: 'working', queued: false })] });
      if (port === beta.ipcPort) return new Response('boom', { status: 500 });
      throw new Error(`unexpected port ${port}`);
    };
    const snapshot = await fetchObserveSnapshot({
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [alpha, beta],
      fetch,
    });
    expect(snapshot.daemons.map(d => [d.larkAppId, d.probe.status])).toEqual([
      ['cli_app_alpha', 'ok'],
      ['cli_app_beta', 'unreachable'],
    ]);
    expect(snapshot.daemons[0]!.sessions).toHaveLength(1);
    expect(snapshot.daemons[1]!.sessions).toEqual([]);
  });
});

describe('fetchObserveSession', () => {
  it('returns the canonical session on 200', async () => {
    const fetch: DaemonIpcFetch = async (_p, path) => {
      expect(path).toBe('/api/sessions/s_alpha_9');
      return jsonResponse({ session: baseRow({ sessionId: 's_alpha_9', status: 'idle', queued: false }) });
    };
    const session = await fetchObserveSession('s_alpha_9', {
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch,
    });
    expect(session.identity.sessionId).toBe('s_alpha_9');
    expect(session.probe.status).toBe('ok');
    expect(session.liveness).toBe('alive');
    expect(session.turn).toBe('idle');
    expect(session.phase).toBe('unknown');
    expect(session.queued).toBe(false);
  });

  it('surfaces not_found without cache fallback', async () => {
    const fetch: DaemonIpcFetch = async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    const session = await fetchObserveSession('s_ghost', {
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch,
      larkAppId: 'cli_app_alpha',
    });
    expect(session.identity.sessionId).toBe('s_ghost');
    expect(session.probe.status).toBe('not_found');
    expect(session.liveness).toBe('unknown');
    expect(session.turn).toBe('unknown');
    expect(session.phase).toBe('unknown');
    expect(session.queued).toBe('unknown');
  });

  it('surfaces daemon_offline when the specified app is not online', async () => {
    const session = await fetchObserveSession('s_x', {
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [],
      fetch: async () => { throw new Error('unreached'); },
      larkAppId: 'cli_missing',
    });
    expect(session.probe).toEqual({ status: 'daemon_offline', source: 'daemon-ipc', larkAppId: 'cli_missing' });
    expect(session.identity.sessionId).toBe('s_x');
  });

  it('fans out and returns the first ok hit across daemons when no larkAppId is provided', async () => {
    const alpha = makeDaemon();
    const beta = makeDaemon({ larkAppId: 'cli_app_beta', ipcPort: 4311 });
    const fetch: DaemonIpcFetch = async (port) => {
      if (port === alpha.ipcPort) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      if (port === beta.ipcPort) return jsonResponse({ session: baseRow({ sessionId: 's_beta_1', status: 'working' }) });
      throw new Error(`unexpected port ${port}`);
    };
    const session = await fetchObserveSession('s_beta_1', {
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [alpha, beta],
      fetch,
    });
    expect(session.identity.sessionId).toBe('s_beta_1');
    expect(session.probe.status).toBe('ok');
    expect(session.turn).toBe('working');
  });

  it('fans out concurrently while selecting the first discovered hit', async () => {
    const alpha = makeDaemon();
    const beta = makeDaemon({ larkAppId: 'cli_app_beta', ipcPort: 4311 });
    let releaseAlpha!: () => void;
    const betaStarted = new Promise<void>(resolve => { releaseAlpha = resolve; });
    const fetch: DaemonIpcFetch = async (port) => {
      if (port === alpha.ipcPort) {
        await betaStarted;
        return jsonResponse({ session: baseRow({ sessionId: 's_target', larkAppId: 'cli_app_alpha' }) });
      }
      releaseAlpha();
      return jsonResponse({ session: baseRow({ sessionId: 's_target', larkAppId: 'cli_app_beta' }) });
    };
    const session = await fetchObserveSession('s_target', {
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [alpha, beta],
      fetch,
      timeoutMs: 50,
    });
    expect(session.identity.larkAppId).toBe('cli_app_alpha');
  });

  it('does not fall back to cached data on unauthorized', async () => {
    const fetch: DaemonIpcFetch = async () => new Response('nope', { status: 401 });
    const session = await fetchObserveSession('s_a', {
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => [makeDaemon()],
      fetch,
      larkAppId: 'cli_app_alpha',
    });
    expect(session.probe.status).toBe('unauthorized');
    expect(session.identity.sessionId).toBe('s_a');
    expect(session.liveness).toBe('unknown');
  });

  it.each([
    { order: 'unauthorized then not_found', statuses: [401, 404] },
    { order: 'not_found then unauthorized', statuses: [404, 401] },
  ])('prioritizes unauthorized over not_found regardless of daemon order: $order', async ({ statuses }) => {
    const daemons = [
      makeDaemon({ larkAppId: 'cli_app_alpha', ipcPort: 4310 }),
      makeDaemon({ larkAppId: 'cli_app_beta', ipcPort: 4311 }),
    ];
    const fetch: DaemonIpcFetch = async port => {
      const status = statuses[port - 4310]!;
      return new Response(status === 401 ? 'unauthorized' : JSON.stringify({ error: 'not_found' }), { status });
    };

    const session = await fetchObserveSession('s_mixed_miss', {
      now: () => OBSERVED_AT,
      secret: 'test',
      discover: () => daemons,
      fetch,
    });

    expect(session.identity.sessionId).toBe('s_mixed_miss');
    expect(session.probe.status).toBe('unauthorized');
    expect(session.liveness).toBe('unknown');
  });
});
