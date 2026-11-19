/**
 * #2062 复审 F1（P1）回归：休眠会话的 Web 终端冷启
 *
 * 回归面（精确）：`composeRowFromActive` 产出的**在内存挂起 ds** 行
 *   status='dormant'（worker=null）、webPort=null、proxyPort=<本机进程级 proxy 端口>
 * 冷启只发生在这一行上：dashboard 前门把 /s/<id> 转给本机 daemon proxy，
 * proxy 的 ensureWorkerPort 钩子（daemon.ts）再从 activeSessions 找到 owner ds 唤醒。
 *
 * 改后 terminalProxyPortOf 要求 webPort>0（=有活 worker）才返回端口，于是
 *   dashboard 前门 → 本机 port 落空 → route registry 也落空（publish 同样跳过 dormant）→ 404
 * 任何走 dashboard 前门的入口都中招：platform `t-` 子域、BOTMUX_PUBLIC_URL、devbox 短链；
 * 且与 BOTMUX_COORDINATION_MODE 无关（disabled 时 registry 就是 undefined）。
 * 仅直连 `host:proxyPort` 的本地分支不受影响。
 *
 * 判据应当是「本机在线 daemon 拥有该行 **且** 有能力服务/唤醒」，而不是「有活 worker」。
 *
 * 断言刻意只落在**行为**上（前门 HTTP 结果 + 冷启钩子是否被调用），
 * 不钉 `terminalProxyPortOf` 的签名或返回值 —— 修法可自由选择。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Aggregator } from '../src/dashboard/aggregator.js';
import { createTerminalFrontProxy } from '../src/dashboard/terminal-front-proxy.js';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { resetTerminalProxy, setTerminalProxyPort } from '../src/core/terminal-url.js';
import { startTerminalProxy, type TerminalProxyHandle } from '../src/core/terminal-proxy.js';

const servers: Server[] = [];
let daemonProxy: TerminalProxyHandle | undefined;

afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  if (daemonProxy) { await daemonProxy.close(); daemonProxy = undefined; }
  resetTerminalProxy();
});

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

/** 在内存挂起的 ds：静默重启 / 空闲挂起后的形态（worker 没了，Session 还活着）。 */
function suspendedDaemonSession(): any {
  return {
    session: {
      sessionId: 'sess-suspended',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      scope: 'thread',
      title: 'suspended',
      status: 'active',
      createdAt: '2026-10-09T00:00:00.000Z',
      larkAppId: 'cli_test',
    },
    larkAppId: 'cli_test',
    chatId: 'oc_chat',
    chatType: 'group',
    worker: null,
    workerPort: null,
    workerReady: false,
  };
}

/** dashboard 前门：/s/<id> → (本机 daemon proxy | 跨 Pod route)。 */
async function frontDoor(aggregator: Aggregator, sessionId: string): Promise<string> {
  const front = createTerminalFrontProxy({
    resolvePort: id => aggregator.terminalProxyPortOf(id),
    resolveActor: () => null,
    control: {} as any,
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://front');
    if (!front.handleHttp(req, res, url)) res.writeHead(404).end('no-route');
  });
  servers.push(server);
  const port = await listen(server);
  const response = await fetch(`http://127.0.0.1:${port}/s/${sessionId}/`);
  return `${response.status}:${await response.text()}`;
}

describe('F1 — 休眠会话仍能从 dashboard 前门冷启终端', () => {
  it('挂起的在内存 ds（dormant + webPort=null + 有 proxyPort）必须转到本机并触发冷启', async () => {
    // worker 冷启后的端口
    const worker = createServer((_req, res) => res.writeHead(200).end('cold-woken-terminal'));
    servers.push(worker);
    const workerPort = await listen(worker);

    let wakeCalls = 0;
    daemonProxy = await startTerminalProxy({
      port: 0,
      host: '127.0.0.1',
      // 本机没有活 worker —— 正是挂起会话的形状
      resolvePort: () => undefined,
      // daemon.ts 的真实钩子：从 activeSessions 找到 owner ds 再 ensureTerminalWorkerPort
      ensureWorkerPort: async (id) => { wakeCalls += 1; return id === 'sess-suspended' ? workerPort : undefined; },
    });
    setTerminalProxyPort(daemonProxy.port);

    const row = composeRowFromActive(suspendedDaemonSession(), { includeTokenUsage: false });
    // 夹具自检：这必须是「挂起」形态，不是「活 worker」形态。
    expect({ status: row.status, webPort: row.webPort, proxyPort: row.proxyPort })
      .toEqual({ status: 'dormant', webPort: null, proxyPort: daemonProxy.port });

    const aggregator = new Aggregator();
    aggregator.hydrateSessions('cli_test', [row as any]);

    await expect(frontDoor(aggregator, 'sess-suspended')).resolves.toBe('200:cold-woken-terminal');
    expect(wakeCalls).toBe(1);
  });

  it('persisted-active 行（无 proxyPort、本进程无 runtime）显式保持 404，不许诺冷启', async () => {
    // composeRowFromPersistedActive：webPort 恒 null、status 恒 dormant、从不写 proxyPort。
    // 本进程没有这条会话的 DaemonSession，daemon proxy 的 ensureWorkerPort 找不到 owner，
    // 把流量发过去只会把 404 变成 502/挂起 —— 所以「无本地路由」是有意为之，钉住它。
    daemonProxy = await startTerminalProxy({
      port: 0,
      host: '127.0.0.1',
      resolvePort: () => undefined,
      // 没有 owner ds 可唤醒：这就是 persisted-active 的真实情形
      ensureWorkerPort: async () => undefined,
    });
    setTerminalProxyPort(daemonProxy.port);

    const aggregator = new Aggregator();
    aggregator.hydrateSessions('cli_test', [{
      sessionId: 'sess-persisted-active',
      larkAppId: 'cli_test',
      status: 'dormant',
      webPort: null,
    }]);

    await expect(frontDoor(aggregator, 'sess-persisted-active'))
      .resolves.toBe('404:session terminal not available');
  });
});

