/**
 * flow `bot` 执行器的 runner 侧（src/flow/bot-executor.ts）：选 bot、派发、轮询、关会话。
 * 全部经注入的 fetch / listDaemons，不起 daemon。
 */
import { describe, expect, it } from 'vitest';
import { closeBotSession, dispatchTurn, pollTurn, resolveAgentBot, type BotExecutorDeps, type BotHttpResponse, type ResolvedBot } from '../src/flow/bot-executor.js';
import { FLOW_AGENT_TURN_ROUTE, type FlowAgentTurnRequest } from '../src/flow/types.js';
import type { OnlineDaemonInfo } from '../src/utils/daemon-discovery.js';

const daemons: OnlineDaemonInfo[] = [
  { larkAppId: 'cli_own', ipcPort: 4001, botName: 'Owner Bot', cliId: 'claude-code' },
  { larkAppId: 'cli_codex', ipcPort: 4002, botName: 'Codex 小助手', cliId: 'codex' },
  { larkAppId: 'cli_claude2', ipcPort: 4003, botName: 'Claude Two', cliId: 'claude-code' },
];

const bot: ResolvedBot = { larkAppId: 'cli_codex', botName: 'Codex 小助手', cliId: 'codex', ipcPort: 4002 };
const turn: FlowAgentTurnRequest = { runId: 'r1', identity: '#0', attempt: 1, gen: 1, turn: 1, sessionId: null, prompt: 'hi', workingDir: '/tmp', timeoutMs: 5000 };

function json(status: number, body: unknown): BotHttpResponse {
  return { status, json: async () => body };
}

function deps(fetch: BotExecutorDeps['fetch'], extra: Partial<BotExecutorDeps> = {}): BotExecutorDeps {
  return { listDaemons: () => daemons, fetch, pollIntervalMs: 5, ...extra };
}

describe('resolveAgentBot', () => {
  it('显式 bot：按 larkAppId 或 displayName（忽略大小写）在线上找；cli 冲突拒绝', () => {
    expect(resolveAgentBot({ bot: 'cli_codex' }, 'cli_own', daemons)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex', ipcPort: 4002 } });
    expect(resolveAgentBot({ bot: 'claude two' }, 'cli_own', daemons)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_claude2' } });
    expect(resolveAgentBot({ bot: 'Codex 小助手', cli: 'codex' }, 'cli_own', daemons)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex' } });
    expect(resolveAgentBot({ bot: 'Codex 小助手', cli: 'claude-code' }, 'cli_own', daemons)).toMatchObject({ ok: false, error: /runs codex, not claude-code/ });
    expect(resolveAgentBot({ bot: 'nobody' }, 'cli_own', daemons)).toMatchObject({ ok: false, error: /not online/ });
    expect(resolveAgentBot({ bot: '  ' }, 'cli_own', daemons)).toMatchObject({ ok: false, error: /must not be empty/ });
  });

  it('按 cli：本 run 所属 bot 的 CLI 相同时优先它，否则第一个在线的同 CLI bot；没有就报在线清单', () => {
    expect(resolveAgentBot({ cli: 'claude-code' }, 'cli_own', daemons)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_own' } });
    expect(resolveAgentBot({ cli: 'claude-code' }, 'cli_codex', daemons)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_own' } });
    expect(resolveAgentBot({ cli: 'codex' }, 'cli_own', daemons)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex' } });
    expect(resolveAgentBot({ cli: 'gemini' }, 'cli_own', daemons)).toMatchObject({ ok: false, error: /no online bot runs cli "gemini" \(online: Owner Bot=claude-code, Codex 小助手=codex, Claude Two=claude-code\)/ });
    expect(resolveAgentBot({ cli: 'gemini' }, 'cli_own', [])).toMatchObject({ ok: false, error: /no daemon is online/ });
  });

  it('都不给：本 run 所属 bot；它离线或 run 无绑定时明确报错', () => {
    expect(resolveAgentBot({}, 'cli_own', daemons)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_own', botName: 'Owner Bot', cliId: 'claude-code' } });
    expect(resolveAgentBot({}, 'cli_gone', daemons)).toMatchObject({ ok: false, error: /cli_gone is not online/ });
    expect(resolveAgentBot({}, null, daemons)).toMatchObject({ ok: false, error: /needs `bot` or `cli` \(this run is not bound to a bot; online: Owner Bot=claude-code, / });
    // 终端 run + 只有一个 bot 在线：不必点名
    expect(resolveAgentBot({}, null, [daemons[1]!])).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex' } });
    expect(resolveAgentBot({}, null, [])).toMatchObject({ ok: false, error: /no daemon is online/ });
  });
});

describe('dispatchTurn', () => {
  it('打 /api/flow/agent-turn，成功返回 sessionId / triggerId / bot 信息', async () => {
    const calls: Array<{ port: number; path: string; body: unknown }> = [];
    const d = deps(async (port, path, init) => {
      calls.push({ port, path, body: init?.body ? JSON.parse(init.body) : null });
      return json(200, { ok: true, sessionId: 's1', triggerId: 't1', bot: 'cli_codex', botName: 'Codex 小助手', cliId: 'codex' });
    });
    const res = await dispatchTurn(d, bot, turn);
    expect(res).toEqual({ ok: true, sessionId: 's1', triggerId: 't1', botName: 'Codex 小助手', cliId: 'codex' });
    expect(calls).toEqual([{ port: 4002, path: FLOW_AGENT_TURN_ROUTE, body: turn }]);
  });

  it('daemon 不可达 → bot_offline；无此路由（裸 404）→ flow_not_enabled；401 → http_error；带 code 的失败原样透传', async () => {
    expect(await dispatchTurn(deps(async () => { throw new Error('ECONNREFUSED'); }), bot, turn)).toMatchObject({ ok: false, code: 'bot_offline', error: /ECONNREFUSED/ });
    expect(await dispatchTurn(deps(async () => json(404, { ok: false, error: 'not found' })), bot, turn)).toMatchObject({ ok: false, code: 'flow_not_enabled', error: /older botmux/ });
    expect(await dispatchTurn(deps(async () => json(401, { ok: false, error: 'unauthorized' })), bot, turn)).toMatchObject({ ok: false, code: 'http_error', error: /401/ });
    expect(await dispatchTurn(deps(async () => json(404, { ok: false, code: 'session_not_found', error: 'gone' })), bot, turn)).toEqual({ ok: false, code: 'session_not_found', error: 'gone' });
    expect(await dispatchTurn(deps(async () => json(501, { ok: false, code: 'flow_not_enabled', error: 'old' })), bot, turn)).toEqual({ ok: false, code: 'flow_not_enabled', error: 'old' });
    expect(await dispatchTurn(deps(async () => ({ status: 500, json: async () => { throw new Error('bad json'); } })), bot, turn)).toMatchObject({ ok: false, code: 'http_error', error: /without a JSON body/ });
  });
});

describe('pollTurn', () => {
  const resultPath = '/api/sessions/s1/trigger-result?triggerId=t1';

  it('running → completed 返回 content；failed / not_found 各归其类', async () => {
    const states = [{ state: 'running' }, { state: 'running' }, { state: 'completed', output: { content: 'PONG' } }];
    const paths: string[] = [];
    const d = deps(async (_port, path) => {
      paths.push(path);
      return json(200, { ok: true, ...states.shift() });
    });
    expect(await pollTurn(d, bot, 's1', 't1', 5000).result).toEqual({ status: 'completed', content: 'PONG' });
    expect(paths).toEqual([resultPath, resultPath, resultPath]);
    expect(await pollTurn(deps(async () => json(200, { ok: true, state: 'failed', error: 'worker died', errorCode: 'no_output' })), bot, 's1', 't1', 5000).result).toEqual({ status: 'failed', error: 'worker died', errorCode: 'no_output' });
    expect(await pollTurn(deps(async () => json(200, { ok: true, state: 'not_found' })), bot, 's1', 't1', 5000).result).toMatchObject({ status: 'lost', error: /no record of session s1/ });
  });

  it('超时 → timeout；stop() → aborted（不再发请求）', async () => {
    let n = 0;
    const d = deps(async () => {
      n++;
      return json(200, { ok: true, state: 'running' });
    });
    expect(await pollTurn(d, bot, 's1', 't1', 40).result).toEqual({ status: 'timeout' });
    const handle = pollTurn(d, bot, 's1', 't1', 5000);
    await new Promise((r) => setTimeout(r, 15));
    const before = n;
    handle.stop();
    expect(await handle.result).toEqual({ status: 'aborted' });
    await new Promise((r) => setTimeout(r, 20));
    expect(n - before).toBeLessThanOrEqual(1);
  });

  it('daemon 连续不可达才判 lost；抖动一次不算', async () => {
    let n = 0;
    const flaky = deps(async () => {
      n++;
      if (n === 1) throw new Error('EAGAIN');
      return json(200, { ok: true, state: n < 3 ? 'running' : 'completed', output: { content: 'ok' } });
    });
    expect(await pollTurn(flaky, bot, 's1', 't1', 5000).result).toEqual({ status: 'completed', content: 'ok' });
    expect(await pollTurn(deps(async () => { throw new Error('down'); }), bot, 's1', 't1', 5000).result).toMatchObject({ status: 'lost', error: /stopped answering/ });
    expect(await pollTurn(deps(async () => json(401, { ok: false })), bot, 's1', 't1', 5000).result).toMatchObject({ status: 'lost', error: /401/ });
  });
});

describe('closeBotSession', () => {
  it('POST /api/sessions/:id/close 带 reason；失败带 daemon 的 error', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const d = deps(async (_port, path, init) => {
      calls.push({ path, body: JSON.parse(init!.body!) });
      return json(200, { ok: true });
    });
    expect(await closeBotSession(d, bot, 's1', 'settled')).toEqual({ ok: true });
    expect(calls).toEqual([{ path: '/api/sessions/s1/close', body: { reason: 'settled' } }]);
    expect(await closeBotSession(deps(async () => json(403, { ok: false, error: 'nope' })), bot, 's1', 'x')).toEqual({ ok: false, error: 'nope' });
    expect(await closeBotSession(deps(async () => { throw new Error('down'); }), bot, 's1', 'x')).toEqual({ ok: false, error: 'down' });
  });
});
