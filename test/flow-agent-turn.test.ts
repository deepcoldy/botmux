/**
 * flow `bot` 执行器的 daemon 侧（src/flow/agent-turn.ts）：请求校验、TriggerRequest 的形状
 * （任务块 only、异步派发、工作目录只在首轮）、应答映射。`triggerSessionTurn` 经注入替身。
 */
import { describe, expect, it } from 'vitest';
import { buildFlowAgentTriggerRequest, handleFlowAgentTurn, parseFlowAgentTurnRequest, type FlowAgentTurnDeps } from '../src/flow/agent-turn.js';
import { buildExternalEventApplicationContext } from '../src/core/trigger-session.js';
import type { TriggerRequest, TriggerResponse } from '../src/services/trigger-types.js';

const base = { runId: 'r1', identity: '#0', attempt: 1, gen: 2, turn: 1, sessionId: null, prompt: 'Reply PONG', workingDir: '/tmp/wd', timeoutMs: 60_000 };

function deps(trigger: FlowAgentTurnDeps['trigger'], registry: Map<string, never> | null = new Map()): FlowAgentTurnDeps {
  return {
    larkAppId: 'cli_own',
    activeSessions: () => registry,
    bot: () => ({ botName: 'Owner Bot', cliId: 'claude-code' }),
    trigger,
  };
}

describe('parseFlowAgentTurnRequest', () => {
  it('必填与类型', () => {
    expect(parseFlowAgentTurnRequest(base)).toEqual({ ok: true, req: base });
    expect(parseFlowAgentTurnRequest({ ...base, sessionId: 'sess', model: ' m1 ' })).toEqual({ ok: true, req: { ...base, sessionId: 'sess', model: 'm1' } });
    expect(parseFlowAgentTurnRequest(null)).toMatchObject({ ok: false });
    expect(parseFlowAgentTurnRequest({ ...base, prompt: '' })).toMatchObject({ ok: false, error: /prompt/ });
    expect(parseFlowAgentTurnRequest({ ...base, turn: 0 })).toMatchObject({ ok: false, error: /turn/ });
    expect(parseFlowAgentTurnRequest({ ...base, timeoutMs: 10 })).toMatchObject({ ok: false, error: /timeoutMs/ });
    expect(parseFlowAgentTurnRequest({ ...base, sessionId: 5 })).toMatchObject({ ok: false, error: /sessionId/ });
    expect(parseFlowAgentTurnRequest({ ...base, prompt: 'x'.repeat(600 * 1024) })).toMatchObject({ ok: false, error: /exceeds/ });
  });
});

describe('buildFlowAgentTriggerRequest', () => {
  it('首轮：无 sessionId、异步派发、instruction = prompt；修复轮带 sessionId', () => {
    const first = buildFlowAgentTriggerRequest(base);
    expect(first).toEqual({
      source: { type: 'workflow', connectorId: 'flow', requestId: 'r1/#0/2-1/1' },
      target: { kind: 'turn' },
      envelope: { format: 'botmux.flow.agent', sourceName: 'flow r1', trusted: false },
      instruction: 'Reply PONG',
      options: { asyncReturnSessionId: true },
    });
    const repair = buildFlowAgentTriggerRequest({ ...base, turn: 2, sessionId: 'sess', model: 'm1' });
    expect(repair.target).toEqual({ kind: 'turn', sessionId: 'sess' });
    expect(repair.options).toEqual({ asyncReturnSessionId: true, model: 'm1' });
    // 任务块渲染：<botmux_task> + 应答模式块（异步模式也带哨兵说明），没有外部事件块
    const ctx = buildExternalEventApplicationContext(first);
    expect(ctx).toContain('<botmux_task trusted="true">\nReply PONG\n</botmux_task>');
    expect(ctx).toContain('<botmux_http_response_mode trusted="true">');
    expect(ctx).not.toContain('botmux_external_event');
  });
});

describe('handleFlowAgentTurn', () => {
  it('首轮：task 模式 + workingDir 注入；成功映射 sessionId / triggerId / bot', async () => {
    const seen: Array<{ req: TriggerRequest; larkAppId: string; internal: unknown }> = [];
    const d = deps(async (req, tdeps, internal) => {
      seen.push({ req, larkAppId: tdeps.larkAppId, internal });
      return { ok: true, triggerId: 'trg_1', action: 'queued', target: { kind: 'turn', sessionId: 'sess_1', chatId: 'http_async_x' }, async: { status: 'pending', sessionId: 'sess_1' } } satisfies TriggerResponse;
    });
    const out = await handleFlowAgentTurn(base, d);
    expect(out).toEqual({ status: 200, body: { ok: true, sessionId: 'sess_1', triggerId: 'trg_1', bot: 'cli_own', botName: 'Owner Bot', cliId: 'claude-code' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.larkAppId).toBe('cli_own');
    expect(seen[0]!.internal).toEqual({ promptMode: 'task', workingDir: '/tmp/wd' });
    expect(seen[0]!.req.instruction).toBe('Reply PONG');
  });

  it('修复轮：不再带 workingDir（既有会话）', async () => {
    let internal: unknown;
    const d = deps(async (_req, _d, i) => {
      internal = i;
      return { ok: true, triggerId: 'trg_2', action: 'queued', target: { kind: 'turn', sessionId: 'sess_1' } };
    });
    await handleFlowAgentTurn({ ...base, turn: 2, sessionId: 'sess_1' }, d);
    expect(internal).toEqual({ promptMode: 'task' });
  });

  it('失败映射：校验 400；session_not_found 404；bad_request 400；其它 502；抛错 500；无 registry 503', async () => {
    expect(await handleFlowAgentTurn({ ...base, prompt: '' }, deps(async () => ({ ok: true })))).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    expect(await handleFlowAgentTurn(base, deps(async () => ({ ok: false, errorCode: 'session_not_found', error: 'gone' })))).toEqual({ status: 404, body: { ok: false, code: 'session_not_found', error: 'gone' } });
    expect(await handleFlowAgentTurn(base, deps(async () => ({ ok: false, errorCode: 'bad_request', error: 'model' })))).toEqual({ status: 400, body: { ok: false, code: 'bad_request', error: 'model' } });
    expect(await handleFlowAgentTurn(base, deps(async () => ({ ok: false, errorCode: 'trigger_failed', error: 'boom' })))).toEqual({ status: 502, body: { ok: false, code: 'dispatch_failed', error: 'boom' } });
    // ok 但没有 session（例如 dry_run 形状）也算派发失败
    expect(await handleFlowAgentTurn(base, deps(async () => ({ ok: true, action: 'dry_run', triggerId: 't' })))).toMatchObject({ status: 502, body: { code: 'dispatch_failed', error: /dry_run/ } });
    expect(await handleFlowAgentTurn(base, deps(async () => { throw new Error('crash'); }))).toEqual({ status: 500, body: { ok: false, code: 'dispatch_failed', error: 'crash' } });
    expect(await handleFlowAgentTurn(base, deps(async () => ({ ok: true }), null))).toMatchObject({ status: 503 });
  });
});
