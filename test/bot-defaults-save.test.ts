import { describe, expect, it, vi } from 'vitest';

import {
  caughtErrorText,
  responseErrorText,
  saveBotField,
  type SaveBotFieldSpec,
  type StatusMessage,
} from '../src/dashboard/web/bot-defaults-save.js';
import type { DashboardJsonResponse } from '../src/dashboard/web/dashboard-api.js';

/**
 * bot-defaults 页约 30 个 save() 共用的「乐观保存」流水线：
 * 清状态 + 置 busy → 请求 → 成功（落地 + ✓）/ 失败（回滚 + ✗）→ 复位 busy。
 * 这里钉住流水线本身，各字段的差异（回包怎么落地、怎么回滚）由调用点的回调承担。
 */

function res(body: any, over: Partial<DashboardJsonResponse> = {}): DashboardJsonResponse {
  return { ok: true, status: 200, body, ...over };
}

/** 记录 setStatus / setBusy / onSaved / rollback 的调用顺序，便于断言「回滚先于 ✗、复位 busy 最后」。 */
function harness(request: SaveBotFieldSpec['request'], extra: Partial<SaveBotFieldSpec> = {}) {
  const events: string[] = [];
  const statuses: StatusMessage[] = [];
  const spec: SaveBotFieldSpec = {
    request,
    setStatus: s => { statuses.push(s); events.push(`status:${s ? s.text : 'null'}`); },
    setBusy: b => { events.push(`busy:${b}`); },
    saved: 'saved',
    ...extra,
  };
  return { spec, events, statuses };
}

describe('saveBotField — 成功', () => {
  it('先清状态再置 busy，成功后：onSaved(body) → ✓ 文案（ok:true）→ 复位 busy；返回 true', async () => {
    const onSaved = vi.fn(() => { events.push('onSaved'); });
    const h = harness(async () => res({ ok: true, value: 7 }), { saved: '已保存', onSaved });
    const { events } = h;
    await expect(saveBotField(h.spec)).resolves.toBe(true);
    expect(onSaved).toHaveBeenCalledWith({ ok: true, value: 7 });
    expect(events).toEqual(['status:null', 'busy:true', 'onSaved', 'status:✓ 已保存', 'busy:false']);
    expect(h.statuses.at(-1)).toEqual({ text: '✓ 已保存', ok: true });
  });

  it('saved 可以是依赖回包的函数；空串只显示 ✓', async () => {
    const a = harness(async () => res({ ok: true, path: '/tmp/x' }), { saved: body => `已保存 → ${body.path}` });
    await saveBotField(a.spec);
    expect(a.statuses.at(-1)).toEqual({ text: '✓ 已保存 → /tmp/x', ok: true });

    const b = harness(async () => res({ ok: true }), { saved: '' });
    await saveBotField(b.spec);
    expect(b.statuses.at(-1)).toEqual({ text: '✓', ok: true });
  });

  it('pendingStatus 作为请求期间的状态，缺省为 null', async () => {
    let seenWhilePending: StatusMessage | undefined;
    const h = harness(async () => { seenWhilePending = h.statuses.at(-1); return res({ ok: true }); }, {
      pendingStatus: { text: '保存中…' },
    });
    await saveBotField(h.spec);
    expect(seenWhilePending).toEqual({ text: '保存中…' });
  });
});

describe('saveBotField — 失败路径', () => {
  it('body.ok 缺失（严格口径）算失败：先 rollback 再 ✗ 文案，最后复位 busy；onSaved 不调用；返回 false', async () => {
    const onSaved = vi.fn();
    const h = harness(async () => res({ error: 'nope' }), { onSaved });
    h.spec.rollback = () => { h.events.push('rollback'); };
    await expect(saveBotField(h.spec)).resolves.toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    expect(h.events).toEqual(['status:null', 'busy:true', 'rollback', 'status:✗ nope', 'busy:false']);
  });

  it('strict:false 时只看 res.ok（写入端点不回 ok 字段也算成功）', async () => {
    const strict = harness(async () => res({ saved: true }));
    await expect(saveBotField(strict.spec)).resolves.toBe(false);

    const loose = harness(async () => res({ saved: true }), { strict: false });
    await expect(saveBotField(loose.spec)).resolves.toBe(true);
    expect(loose.statuses.at(-1)).toEqual({ text: '✓ saved', ok: true });

    // strict:false 下 res.ok 仍为 false（HTTP 非 2xx 或 body.ok === false）照样失败。
    const failed = harness(async () => res({ ok: false, error: 'bad' }, { ok: false, status: 400 }), { strict: false });
    await expect(saveBotField(failed.spec)).resolves.toBe(false);
    expect(failed.statuses.at(-1)).toEqual({ text: '✗ bad' });
  });

  it('请求抛错：rollback 并显示 ✗ + 错误 message；busy 仍复位', async () => {
    const rollback = vi.fn();
    const h = harness(async () => { throw new TypeError('Failed to fetch'); }, { rollback });
    await expect(saveBotField(h.spec)).resolves.toBe(false);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(h.statuses.at(-1)).toEqual({ text: '✗ Failed to fetch' });
    expect(h.events.at(-1)).toBe('busy:false');
  });

  it('onSaved 里抛错按失败处理（与原先落地逻辑写在 try 里一致）：rollback + ✗，且不会再出现 ✓', async () => {
    const rollback = vi.fn();
    const h = harness(async () => res({ ok: true }), {
      onSaved: () => { throw new Error('bad payload'); },
      rollback,
    });
    await expect(saveBotField(h.spec)).resolves.toBe(false);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(h.statuses.map(s => (s ? s.text : null))).toEqual([null, '✗ bad payload']);
    expect(h.statuses.some(s => s?.ok)).toBe(false);
  });

  it('errorText 可按回包定制失败文案', async () => {
    const h = harness(async () => res({ ok: false, error: 'invalid_auto_start_excluded_chats' }, { ok: false }), {
      strict: false,
      errorText: r => r.body?.error === 'invalid_auto_start_excluded_chats' ? '排除群格式不对' : responseErrorText(r),
    });
    await saveBotField(h.spec);
    expect(h.statuses.at(-1)).toEqual({ text: '✗ 排除群格式不对' });
  });

  it('没有 rollback 的调用点（如 CrossBot）失败时只改状态', async () => {
    const h = harness(async () => res({ ok: false, error: 'x' }, { ok: false }));
    await expect(saveBotField(h.spec)).resolves.toBe(false);
    expect(h.events).toEqual(['status:null', 'busy:true', 'status:✗ x', 'busy:false']);
  });
});

describe('responseErrorText / caughtErrorText', () => {
  it('reason + manualCommand 合并；否则 reason > error > HTTP 状态码', () => {
    expect(responseErrorText(res({ reason: '缺登录态', manualCommand: 'botmux login' }))).toBe('缺登录态（botmux login）');
    expect(responseErrorText(res({ reason: '缺登录态' }))).toBe('缺登录态');
    expect(responseErrorText(res({ error: 'boom' }))).toBe('boom');
    expect(responseErrorText(res({}, { status: 502 }))).toBe('502');
    expect(responseErrorText(res(null, { status: 500 }))).toBe('500');
  });

  it('caughtErrorText：有 message 取 message，否则 String(e)', () => {
    expect(caughtErrorText(new Error('x'))).toBe('x');
    expect(caughtErrorText('plain')).toBe('plain');
    expect(caughtErrorText(undefined)).toBe('undefined');
  });
});
