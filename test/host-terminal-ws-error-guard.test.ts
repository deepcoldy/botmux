/**
 * The host-terminal upgrade callback has a term.exited TOCTOU re-check that
 * closes a freshly upgraded socket before any Client exists. On bun 1.4.4 / npm
 * ws a server-side socket with no 'error' listener raises an uncaughtException
 * on a malformed frame, and the dashboard has no process-level trap, so that
 * early-return path needs the guard attached first. The race (term exits between
 * the pre-upgrade check and the upgrade callback) cannot be driven deterministically
 * through the public HTTP surface, hence this structural tripwire.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(join(process.cwd(), 'src/dashboard/host-terminal.ts'), 'utf8');

// 源码结构护栏(K3)：dashboard 无 uncaughtException 兜底，host-terminal 服务端 ws
// 缺 error 监听会让一个畸形帧崩掉整个 dashboard（波及全部宿主终端）；该 TOCTOU 早退
// 路径无确定性行为 seam，只能钉「error 监听先于 term.exited 早退挂载」这一结构不变量。
describe('host-terminal upgrade sockets', () => {
  it('attach an error listener before the term.exited early return can close the socket', () => {
    const callbackStart = source.indexOf('wss.handleUpgrade(req, socket as any, head, (ws) => {');
    expect(callbackStart).toBeGreaterThan(-1);
    const callback = source.slice(callbackStart);
    const errorListener = callback.search(/\bws\.on\('error'/);
    const earlyReturn = callback.indexOf('if (term.exited)');
    expect(errorListener).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(errorListener).toBeLessThan(earlyReturn);
  });
});
