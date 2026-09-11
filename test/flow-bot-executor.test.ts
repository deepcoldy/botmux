/**
 * flow `bot` 执行器的 runner 侧（src/flow/bot-executor.ts）：选 bot、派发、轮询、关会话。
 * 全部经注入的 fetch / listDaemons，不起 daemon。
 */
import { describe, expect, it } from 'vitest';
import { closeBotSession, dispatchTurn, knownBots, pollTurn, resolveAgentBot, type BotExecutorDeps, type BotHttpResponse, type ResolvedBot } from '../src/flow/bot-executor.js';
import type { ConfiguredBot } from '../src/flow/configured-bots.js';
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

/** bots.json 视角：比在线名单多一个离线的 gemini bot，少 cli_claude2 的 displayName（它只有在线 botName）。 */
const configured: ConfiguredBot[] = [
  { larkAppId: 'cli_own', displayName: 'Owner Bot', cliId: 'claude-code' },
  { larkAppId: 'cli_codex', displayName: 'Codex 小助手', cliId: 'codex' },
  { larkAppId: 'cli_claude2', cliId: 'claude-code' },
  { larkAppId: 'cli_gemini', displayName: 'Gemini 帮手', cliId: 'gemini' },
];

describe('knownBots', () => {
  it('bots.json 与在线描述符按 larkAppId 合并：在线的带 daemon，只配置的标 offline，只在线的标未配置', () => {
    const known = knownBots(configured, daemons);
    expect(known.map((b) => [b.larkAppId, b.name, b.cliId, !!b.online, b.configured])).toEqual([
      ['cli_own', 'Owner Bot', 'claude-code', true, true],
      ['cli_codex', 'Codex 小助手', 'codex', true, true],
      ['cli_claude2', 'Claude Two', 'claude-code', true, true],
      ['cli_gemini', 'Gemini 帮手', 'gemini', false, true],
    ]);
    expect(known[2]!.aliases).toEqual(['cli_claude2', 'claude two']);
    expect(knownBots(null, [daemons[1]!]).map((b) => [b.larkAppId, b.configured, b.aliases])).toEqual([['cli_codex', false, ['cli_codex', 'codex 小助手']]]);
    // 端口非法的描述符不算在线
    expect(knownBots(null, [{ larkAppId: 'x', ipcPort: 0 }])).toEqual([]);
  });
});

describe('resolveAgentBot', () => {
  it('显式 bot：按 larkAppId / displayName / 在线 botName（忽略大小写）找；必须存在且在线；cli 只做断言', () => {
    expect(resolveAgentBot({ bot: 'cli_codex' }, 'cli_own', daemons, configured)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex', ipcPort: 4002, botName: 'Codex 小助手' } });
    expect(resolveAgentBot({ bot: 'claude two' }, 'cli_own', daemons, configured)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_claude2' } });
    expect(resolveAgentBot({ bot: 'Codex 小助手', cli: 'codex' }, 'cli_own', daemons, configured)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex' } });
    expect(resolveAgentBot({ bot: 'Codex 小助手', cli: 'claude-code' }, 'cli_own', daemons, configured)).toMatchObject({ ok: false, error: /bot "Codex 小助手" runs codex, not claude-code/ });
    // 配了但 daemon 没起：明确说是离线，而不是「不存在」
    expect(resolveAgentBot({ bot: 'Gemini 帮手' }, 'cli_own', daemons, configured)).toMatchObject({ ok: false, error: /bot "Gemini 帮手" \(cli_gemini, gemini\) is configured but its daemon is not online/ });
    // 既不在 bots.json 也没有在线 daemon 叫这个名：不存在，并列出已知 bot（含在线状态）
    expect(resolveAgentBot({ bot: 'nobody' }, 'cli_own', daemons, configured)).toMatchObject({
      ok: false,
      error: /bot "nobody" is not a known bot \(not in bots\.json, and no online daemon has that name\); known bots: Owner Bot=claude-code \[online\], Codex 小助手=codex \[online\], Claude Two=claude-code \[online\], Gemini 帮手=gemini \[offline\]/,
    });
    // bots.json 读不到：只能按在线名单校验
    expect(resolveAgentBot({ bot: 'Gemini 帮手' }, 'cli_own', daemons, null)).toMatchObject({ ok: false, error: /not a known bot .*known bots: Owner Bot=claude-code \[online\], Codex 小助手=codex \[online\], Claude Two=claude-code \[online\]$/ });
    expect(resolveAgentBot({ bot: 'nobody' }, 'cli_own', [], [])).toMatchObject({ ok: false, error: /no bot is configured and no daemon is online/ });
    expect(resolveAgentBot({ bot: '  ' }, 'cli_own', daemons, configured)).toMatchObject({ ok: false, error: /must not be empty/ });
    // 同一个 displayName 配给了两个 bot：不猜，要 larkAppId
    const dup: ConfiguredBot[] = [...configured, { larkAppId: 'cli_codex2', displayName: 'Codex 小助手', cliId: 'codex' }];
    expect(resolveAgentBot({ bot: 'codex 小助手' }, 'cli_own', daemons, dup)).toMatchObject({ ok: false, error: /matches more than one bot \(cli_codex, cli_codex2\); use its larkAppId/ });
  });

  it('cli 不选人：本 run 所属 bot 的 CLI 一致就用它，不一致直接拒绝并提示点名，绝不改挑别的同 CLI bot', () => {
    expect(resolveAgentBot({ cli: 'claude-code' }, 'cli_own', daemons, configured)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_own' } });
    // 从 codex bot 的话题里要 claude-code：有两个在线的 claude-code bot，不能替脚本挑
    expect(resolveAgentBot({ cli: 'claude-code' }, 'cli_codex', daemons, configured)).toMatchObject({
      ok: false,
      error: /agent cli "claude-code" does not match this run's bot Codex 小助手 \(codex\); name the executing bot with `bot` \(claude-code bots: Owner Bot \[online\], Claude Two \[online\]\)/,
    });
    // 哪怕同 CLI 的 bot 只有一个也不自动选：脚本要写 bot
    expect(resolveAgentBot({ cli: 'codex' }, 'cli_own', daemons, configured)).toMatchObject({ ok: false, error: /does not match this run's bot Owner Bot \(claude-code\); .*\(codex bots: Codex 小助手 \[online\]\)/ });
    expect(resolveAgentBot({ cli: 'gemini' }, 'cli_own', daemons, configured)).toMatchObject({ ok: false, error: /\(gemini bots: Gemini 帮手 \[offline\]\)/ });
    expect(resolveAgentBot({ cli: 'opencode' }, 'cli_own', daemons, configured)).toMatchObject({ ok: false, error: /\(no known bot runs opencode\)/ });
    expect(resolveAgentBot({ cli: ' ' }, 'cli_own', daemons, configured)).toMatchObject({ ok: false, error: /`cli` must not be empty/ });
  });

  it('都不给：本 run 所属 bot；它离线或 run 无绑定时明确报错', () => {
    expect(resolveAgentBot({}, 'cli_own', daemons, configured)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_own', botName: 'Owner Bot', cliId: 'claude-code' } });
    expect(resolveAgentBot({}, 'cli_gemini', daemons, configured)).toMatchObject({ ok: false, error: /this run's bot cli_gemini is not online; start it, or name another bot with `bot`/ });
    expect(resolveAgentBot({}, 'cli_gone', daemons, configured)).toMatchObject({ ok: false, error: /cli_gone is not online/ });
    expect(resolveAgentBot({}, null, daemons, configured)).toMatchObject({ ok: false, error: /agent needs `bot` \(this run is not bound to a bot; known bots: Owner Bot=claude-code \[online\], / });
    // 终端 run：已知 bot 恰好一个才不必点名——按 bots.json 算，不按「谁在线」猜
    expect(resolveAgentBot({}, null, [daemons[1]!], [configured[1]!])).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex' } });
    expect(resolveAgentBot({ cli: 'claude-code' }, null, [daemons[1]!], [configured[1]!])).toMatchObject({ ok: false, error: /bot Codex 小助手 runs codex, not claude-code/ });
    expect(resolveAgentBot({}, null, [daemons[1]!], configured)).toMatchObject({ ok: false, error: /agent needs `bot` \(this run is not bound to a bot; known bots: .*Gemini 帮手=gemini \[offline\]\)/ });
    expect(resolveAgentBot({}, null, [], [configured[3]!])).toMatchObject({ ok: false, error: /bot Gemini 帮手 \(cli_gemini, gemini\) is configured but its daemon is not online/ });
    // bots.json 读不到时退回在线名单：只有一个在线就用它
    expect(resolveAgentBot({}, null, [daemons[1]!], null)).toMatchObject({ ok: true, bot: { larkAppId: 'cli_codex' } });
    expect(resolveAgentBot({}, null, [], null)).toMatchObject({ ok: false, error: /no bot is configured and no daemon is online/ });
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
