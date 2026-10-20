import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  latestLarkToolBindingForRespawn,
  requestSessionRestart,
  __testOnly_resetRestartCoordinator,
} from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';
import type { DaemonSession } from '../src/core/types.js';

describe('latestLarkToolBindingForRespawn (daemon-side carrier)', () => {
  const makeSession = (appId = 'cli_test'): DaemonSession => ({
    larkAppId: appId,
    session: { sessionId: 's1' },
  } as unknown as DaemonSession);

  it('returns true when larkToolBinding is explicitly enabled on the bot or unconfigured (default on)', () => {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { larkAppId: 'cli_test', larkToolBinding: true },
    } as any);
    expect(latestLarkToolBindingForRespawn(makeSession())).toBe(true);

    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { larkAppId: 'cli_test' },
    } as any);
    expect(latestLarkToolBindingForRespawn(makeSession())).toBe(true);
  });

  it('returns null when larkToolBinding is explicitly false (worker clears snapshot)', () => {
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({
      config: { larkAppId: 'cli_test', larkToolBinding: false },
    } as any);
    expect(latestLarkToolBindingForRespawn(makeSession())).toBeNull();
  });

  it('returns undefined when bot lookup throws (worker keeps snapshot)', () => {
    vi.spyOn(botRegistry, 'getBot').mockImplementation(() => {
      throw new Error('bot_not_found');
    });
    expect(latestLarkToolBindingForRespawn(makeSession())).toBeUndefined();
  });
});

describe('requestSessionRestart live-worker branch carries larkToolBinding', () => {
  afterEach(() => {
    __testOnly_resetRestartCoordinator();
    vi.restoreAllMocks();
  });

  it.each([
    [{ larkToolBinding: false }, null],
    [{ larkToolBinding: true }, true],
    [{}, true],
  ] as const)('bot config %o → restart IPC larkToolBinding %s', (botConfig, expected) => {
    __testOnly_resetRestartCoordinator();
    vi.spyOn(botRegistry, 'getBot').mockReturnValue({ config: { larkAppId: 'cli_test', ...botConfig } } as any);
    const send = vi.fn();
    const ds = { larkAppId: 'cli_test', session: { sessionId: `ltb-${String(expected)}` }, worker: { killed: false, send } };
    const request = requestSessionRestart(ds as unknown as DaemonSession, { source: 'slash', notify: vi.fn(async () => {}) } as any);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: 'restart', attemptId: request!.attemptId, larkToolBinding: expected });
  });
});

describe('restart IPC choke point', () => {
  // 源码结构护栏(K1)：in-worker `restart` IPC 只能由 requestSessionRestart 发出——它负责铸 attemptId
  // 并捎带最新 env / model / larkToolBinding（上面与 env、model 两个文件的行为用例只覆盖这一个发送方）。
  // 绕开它的裸 restart 拿不到 restart_result，workerReady 栅栏永不放开、会话的 fork / relay /
  // dashboard 生命周期操作永久 worker_busy（757b43dc1d，#1863/#2033）。扫描整个 src/ 而非点名文件。
  it('every daemon-side restart IPC is sent from inside requestSessionRestart', () => {
    const srcRoot = new URL('../src/', import.meta.url);
    const files = (readdirSync(srcRoot, { recursive: true }) as string[])
      .filter(f => f.endsWith('.ts') && f !== 'worker.ts');
    const senders: string[] = [];
    for (const file of files) {
      const source = readFileSync(new URL(file, srcRoot), 'utf8');
      for (const m of source.matchAll(/\.send\(\{\s*type: 'restart'[,\s}]/g)) senders.push(`${file}@${m.index}`);
    }
    const pool = readFileSync(new URL('core/worker-pool.ts', srcRoot), 'utf8');
    const fn = pool.indexOf('export function requestSessionRestart(');
    const end = pool.indexOf('\n}\n', fn);
    expect(fn).toBeGreaterThan(0);
    expect(senders.length).toBeGreaterThan(0);
    for (const sender of senders) {
      const [file, at] = sender.split('@');
      expect(file, `restart IPC sent outside requestSessionRestart: ${sender}`).toBe(join('core', 'worker-pool.ts'));
      expect(Number(at)).toBeGreaterThan(fn);
      expect(Number(at)).toBeLessThan(end);
    }
  });
});
