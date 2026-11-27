import { afterEach, describe, expect, it, vi } from 'vitest';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { parseBotConfigsFromText, registerBot, __testOnly_resetBotRegistry } from '../src/bot-registry.js';
import { REMOTE_RUNNER_PROTOCOL_VERSION } from '../src/adapters/backend/remote-runner-protocol.js';
import * as pool from '../src/core/worker-pool.js';
import { WecomHttpCore } from '../src/im/wecom/gateway/core-client.js';
import { renderWecomProgress } from '../src/im/wecom/gateway/presentation.js';

/**
 * The WeCom streaming usage line is rendered by the gateway from the progress
 * the dedicated core serves. The core fills `progress.usage` from the daemon's
 * card usage snapshot, whose cumulative tokens are `{ in, out }`. A renderer
 * that reads any other field shows "undefined" for every session whose snapshot
 * carries only those (Remote Runner sessions do).
 */

const secret = 'wecom-streaming-usage-fixture-secret';
let server: IpcServerHandle | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  setIpcAuthSecret(null);
  setLarkAppId('');
  __testOnly_resetBotRegistry();
  vi.restoreAllMocks();
});

async function startCoreWithRemoteRunnerUsage() {
  __testOnly_resetBotRegistry();
  registerBot(parseBotConfigsFromText(JSON.stringify([
    { larkAppId: 'local_usage', apiOnly: true, cliId: 'codex' },
  ]))[0]);
  setIpcAuthSecret(secret);
  setLarkAppId('local_usage');
  // A live HTTP turn on a Remote Runner session: the real usage snapshot comes
  // from the runner's report, which carries only the card fields.
  const ds: any = {
    larkAppId: 'local_usage',
    chatId: 'http_async_usage',
    workerGeneration: 3,
    initConfig: { backendType: 'remote-runner' },
    session: {
      sessionId: 'usage-session',
      larkAppId: 'local_usage',
      chatId: 'http_async_usage',
      remoteBackendState: { version: REMOTE_RUNNER_PROTOCOL_VERSION, provider: 'fixture', generation: 1 },
      remoteRunnerUsage: {
        generation: 1,
        snapshot: {
          context: { usedTokens: 4123, windowTokens: 200000 },
          tokens: { in: 52345, out: 1789, cacheReadTokens: 40000 },
          turnTokens: { in: 913, out: 77 },
        },
      },
    },
    asyncTriggerResults: new Map([['turn', { status: 'pending' }]]),
    activeInteractiveTurn: { turnId: 'turn' },
    lastThinkingUpdate: { workerGeneration: 3, turnId: 'turn', entries: [] },
  };
  vi.spyOn(pool, 'findActiveBySessionId').mockImplementation(id => id === 'usage-session' ? ds : undefined);
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true, coreOnlyPublicRoutes: true });
  const port = server.port;
  // The gateway's core client, authenticated the way the managed core requires.
  const request = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = daemonIpcAuthHeaders({
      secret,
      port,
      method: init?.method ?? 'GET',
      path: url.pathname + url.search,
      headers: init?.headers,
    });
    return fetch(url, { ...init, headers });
  }) as typeof fetch;
  return { ds, core: new WecomHttpCore(`http://127.0.0.1:${port}`, request) };
}

describe('WeCom streaming usage line', () => {
  it('shows the numbers of the core usage snapshot, not undefined', async () => {
    const { ds, core } = await startCoreWithRemoteRunnerUsage();
    const snapshot = pool.getDaemonSessionUsageSnapshot(ds);
    const progress = await core.progress('usage-session', 'turn');
    expect(progress).toBeTruthy();

    const rendered = renderWecomProgress(progress!, { usageDisplay: 'streaming' });

    expect(rendered).not.toContain('undefined');
    const shown = (rendered.match(/\d+/g) ?? []).map(Number).sort((a, b) => a - b);
    const expected = [
      snapshot.context!.usedTokens,
      snapshot.context!.windowTokens!,
      snapshot.tokens!.in,
      snapshot.tokens!.out,
      snapshot.turnTokens!.in,
      snapshot.turnTokens!.out,
    ].sort((a, b) => a - b);
    expect(shown).toEqual(expected);
  });
});
