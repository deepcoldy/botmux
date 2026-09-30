import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * worker.ts 的 submit-failure 现场分类接线（结构化 source pin），仿
 * submit-failure-lifecycle-wiring.test.ts 的 compact 风格：
 *   - runDeferredRecheck switch 结束、dropFailedBridgeMark 之前调用纯函数
 *     diagnoseSubmitFailure；
 *   - ZMX 屏幕历史非权威：effectiveBackendType !== 'zmx' 时才读屏
 *     （backend 走 captureBackendScreen，否则退化到 analyzer/renderer 快照）；
 *   - still_active 是弱证据，只允许在 SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA
 *     上限内复用 armDeferredRecheck() 再静默一次，禁止裸 setTimeout 递归；
 *   - logged_out/interactive_menu/draft_parked 三类只分叉用户卡 t() key；
 *   - emitDurableTerminal('submit_unconfirmed') 错误码不变。
 */

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

function compact(text: string): string {
  return text.replace(/\s+/g, '').replace(/,\)/g, ')');
}

function scheduleSlice(): string {
  const start = source.indexOf('function scheduleSubmitFailureNotify');
  const end = source.indexOf('function detectBareShellLaunch', start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return compact(source.slice(start, end));
}

describe('worker submit-failure diagnosis wiring', () => {
  it('在发卡前调用 diagnoseSubmitFailure，喂入屏幕文本与 lastPtyActivityAtMs', () => {
    const slice = scheduleSlice();
    const call = slice.indexOf('diagnoseSubmitFailure({');
    expect(call).toBeGreaterThanOrEqual(0);
    const callArgs = slice.slice(call, slice.indexOf('});', call) + 3);
    expect(callArgs).toContain('screenText:submitDiagnosisScreen');
    expect(callArgs).toContain('lastActivityAtMs:lastPtyActivityAtMs');
  });

  it('非 zmx 才读屏：captureBackendScreen 位于 zmx 守卫分支内', () => {
    const slice = scheduleSlice();
    const guard = slice.indexOf('if(effectiveBackendType!==\'zmx\')');
    const capture = slice.indexOf('captureBackendScreen(backend)');
    const diagCall = slice.indexOf('diagnoseSubmitFailure({');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(guard);
    expect(diagCall).toBeGreaterThan(capture);
    // backend 缺失时退化到 analyzer/renderer 快照。
    expect(slice).toContain('lastAnalyzerSnapshot||renderer?.rawSnapshot()||\'\'');
  });

  it('读屏抛错时退化为空屏幕而不是打断重查', () => {
    const slice = scheduleSlice();
    expect(slice).toContain('catch{submitDiagnosisScreen=\'\';}');
  });

  it('still_active 弱证据只在上限内复用 armDeferredRecheck，且无裸 setTimeout', () => {
    const slice = scheduleSlice();
    const branchStart = slice.indexOf("submitDiagnosis.reason==='still_active'");
    expect(branchStart).toBeGreaterThanOrEqual(0);
    const branchEnd = slice.indexOf('Submitfailurediagnosis:', branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = slice.slice(branchStart, branchEnd);
    expect(branch).toContain('activeSilenceExtra<SUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA');
    expect(branch).toContain('chainIsCurrent()');
    expect(branch).toContain('armDeferredRecheck()');
    expect(branch).not.toContain('setTimeout');
  });

  it('静默上限常量定义在既有 deferred 常量旁，计数器挨着 deferredRecheckAttempts', () => {
    const compactSource = compact(source);
    const maxConstant = compactSource.indexOf('constSUBMIT_DIAG_ACTIVE_SILENCE_MAX_EXTRA=3;');
    expect(maxConstant).toBeGreaterThanOrEqual(0);
    // 紧挨既有 SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS 常量（200 字符内）。
    const deferredMax = compactSource.indexOf('constSUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS=2;');
    expect(deferredMax).toBeGreaterThanOrEqual(0);
    expect(Math.abs(maxConstant - deferredMax)).toBeLessThan(200);
    const slice = scheduleSlice();
    const counters = slice.indexOf('letdeferredRecheckAttempts=0;');
    expect(counters).toBeGreaterThanOrEqual(0);
    expect(slice.slice(counters, counters + 80)).toContain('letactiveSilenceExtra=0;');
  });

  it('三类屏幕诊断各自分叉 t() key，zmx 与兜底维持原 key', () => {
    const slice = scheduleSlice();
    expect(slice).toContain("'submitDiag.logged_out'");
    expect(slice).toContain("'submitDiag.interactive_menu'");
    expect(slice).toContain("'submitDiag.draft_parked'");
    expect(slice).toContain("'worker.submit_unconfirmed_zmx'");
    expect(slice).toContain("'worker.submit_unconfirmed'");
  });

  it('durable 终态错误码仍为 submit_unconfirmed，且分类插在 dropFailedBridgeMark 之前', () => {
    const slice = scheduleSlice();
    const diagCall = slice.indexOf('diagnoseSubmitFailure({');
    const drop = slice.indexOf('dropFailedBridgeMark(', diagCall);
    const terminal = slice.indexOf("emitDurableTerminal('submit_unconfirmed')", diagCall);
    expect(diagCall).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(diagCall);
    expect(terminal).toBeGreaterThan(drop);
  });
});
