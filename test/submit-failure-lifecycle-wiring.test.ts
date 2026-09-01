import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * worker.ts 的 submit-failure 生命周期接线（结构化 source pin）：
 *   - scheduleSubmitFailureNotify 通过按 (turnId, dispatchAttempt, cliGeneration)
 *     键控的控制器调度/替换/取消重查，而不是裸 setTimeout 无限递归；
 *   - 强成功证据（structured-transcript / botmux-send）取消整条链，不再重查也不再告警；
 *   - 弱 pty-output 才重查，但只保留一条 live 链；
 *   - 确认 / stale generation / terminal / warning 都会清链；
 *   - flushPending 抛错分支先落 write_input_threw 终态回执、再调度失败链（终态先于调度 ⟹ 链不 arm）。
 *
 * 所有断言都先把源码压缩空白再做子串匹配，忽略换行/缩进等无害格式化差异，
 * 因此"多行参数、加括号"这类纯格式改动不会误红；删除分支/换调用等真语义破坏仍会红。
 * 多行参数写法会在最后一个参数后留尾随逗号（`deferredAttemptIsCurrent,),`），
 * compact 顺带把 `,)` 归一成 `)`，消除这一同类差异。
 */

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

/** 压缩所有空白（含换行/缩进），并把多行参数留下的尾随逗号 `,)` 归一成 `)`，
 *  让断言对"单行 vs 多行参数"这一无害格式化鲁棒。 */
function compact(text: string): string {
  return text.replace(/\s+/g, '').replace(/,\)/g, ')');
}

function functionSlice(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return compact(source.slice(start, end));
}

describe('worker submit-failure lifecycle wiring', () => {
  it('routes the deferred recheck through a per-attempt chain controller', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    expect(schedule).toContain('submitFailureChains.schedule(');
    expect(schedule).toContain('turnIdentity?.turnId');
    expect(schedule).toContain('turnIdentity?.dispatchAttempt');
    expect(schedule).toContain('cliGenerationAtSchedule');
  });

  it('replaces an existing live chain instead of stacking a second timer', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const scheduleCall = schedule.indexOf('submitFailureChains.schedule(');
    expect(scheduleCall).toBeGreaterThanOrEqual(0);
    expect(schedule.slice(scheduleCall, schedule.indexOf(');', scheduleCall) + 2)).toContain('SUBMIT_DEFERRED_RECHECK_MS');
    expect(schedule).toContain('replaced');
  });

  it('keeps identity-less retries inside the controller and does not recurse', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const activeStart = schedule.indexOf("case'suppress-active':");
    const activeEnd = schedule.indexOf("case'notify-hard-failure':", activeStart);
    const active = schedule.slice(activeStart, activeEnd);
    expect(schedule).not.toContain('setTimeout(()=>{voidrunDeferredRecheck();}');
    expect(active).not.toContain('scheduleSubmitFailureNotify(');
    expect(active).toContain('armDeferredRecheck()');
  });

  it('bounds weak-activity rechecks before emitting the single warning', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const activeStart = schedule.indexOf("case'suppress-active':");
    const activeEnd = schedule.indexOf("case'notify-hard-failure':", activeStart);
    const active = schedule.slice(activeStart, activeEnd);
    expect(schedule).toContain('SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS');
    expect(active).toContain('deferredRecheckAttempts<SUBMIT_DEFERRED_RECHECK_MAX_ATTEMPTS');
    expect(active).toContain('break;');
  });

  it('cancels the chain on strong success evidence instead of re-arming', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const activeStart = schedule.indexOf("case'suppress-active':");
    const activeEnd = schedule.indexOf("case'notify-hard-failure':", activeStart);
    expect(activeStart).toBeGreaterThanOrEqual(0);
    expect(activeEnd).toBeGreaterThan(activeStart);
    const active = schedule.slice(activeStart, activeEnd);
    expect(active).toContain('structured-transcript');
    expect(active).toContain('botmux-send');
    // 强证据分支必须在重查之前 return，已触发的 timer 由控制器忘记，
    // 不能按 key 取消并发替换 timer。
    const returnIdx = active.indexOf('return;');
    const rearmIdx = active.indexOf('scheduleSubmitFailureNotify(');
    expect(returnIdx).toBeGreaterThanOrEqual(0);
    expect(rearmIdx).toBe(-1);
  });

  it('does not let a completed callback cancel a replacement timer for the same key', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    const callbackStart = schedule.indexOf('construnDeferredRecheck');
    const armStart = schedule.indexOf('constarmDeferredRecheck', callbackStart);
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    expect(armStart).toBeGreaterThan(callbackStart);
    expect(schedule.slice(callbackStart, armStart)).not.toContain('submitFailureChains.cancel(');
  });

  it('passes the Promise-returning settlement callback to the controller', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    // compact 已把多行参数尾随逗号 `,)` 归一成 `)`，所以这里断言到参数结尾即可。
    expect(schedule).toContain('runDeferredRecheck)');
    expect(schedule).not.toContain('()=>{voidrunDeferredRecheck();}');
    // 只钉「存在 chainIsCurrent 守卫 + 组合围栏」这一语义；对是否加大括号鲁棒。
    expect(schedule).toContain('if(!chainIsCurrent())');
    expect(schedule).toContain('isCurrent:combineSubmitCurrentFences(chainIsCurrent,deferredAttemptIsCurrent)');
  });

  it('scopes strong activity evidence to the exact turn and dispatch attempt', () => {
    const schedule = functionSlice('scheduleSubmitFailureNotify', 'detectBareShellLaunch');
    expect(schedule).toContain('submitActivityEvidenceSince(activityBaselineMs,turnIdentity)');
    expect(compact(source)).toContain('selectSubmitActivityEvidence({');
    expect(compact(source)).toContain('target:identity');
  });

  it('cancels the exact deferred chain from the shared terminal boundary', () => {
    const terminal = functionSlice('emitTurnTerminal', 'workerIpcPayload');
    const cancel = terminal.indexOf('cancelSubmitFailureChainForTerminal(');
    const dedupe = terminal.indexOf('emittedTurnTerminals.claim(');
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(dedupe);
    expect(terminal).toContain('{turnId,dispatchAttempt}');
    expect(terminal).toContain('cliSpawnGeneration');
  });

  it('emits the write_input_threw terminal before scheduling the failure chain in flushPending', () => {
    // flushPending 抛错分支：先 emitTurnTerminal('write_input_threw') 落终态回执，
    // 再 scheduleSubmitFailureNotify —— 终态先于调度，同 key 的重查链不会 arm，
    // 重复的 submit_unconfirmed 文本告警被抑制（turn_terminal 仍会发失败卡片）。
    const compactSource = compact(source);
    const terminalIdx = compactSource.indexOf(
      "emitTurnTerminal(item.turnId,'ambiguous','write_input_threw',item.dispatchAttempt)",
    );
    expect(terminalIdx).toBeGreaterThanOrEqual(0);
    const scheduleIdx = compactSource.indexOf('scheduleSubmitFailureNotify(', terminalIdx);
    expect(scheduleIdx).toBeGreaterThan(terminalIdx);
  });
});
