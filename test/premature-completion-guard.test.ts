import { describe, expect, it } from 'vitest';
import {
  PREMATURE_COMPLETION_ERROR_CODE,
  shouldRecoverPrematureCompletion,
} from '../src/services/premature-completion-guard.js';
import {
  ORDINARY_TURN_RECOVERY_PROMPT,
  PREMATURE_COMPLETION_RECOVERY_PROMPT,
} from '../src/services/ordinary-turn-recovery.js';

function candidate(overrides: Partial<Parameters<typeof shouldRecoverPrematureCompletion>[0]> = {}) {
  return {
    cliId: 'traex',
    turnId: 'om_execution',
    requestText: '<user_message>\n修复这个问题，运行测试并确认结果。\n</user_message>',
    finalText: '我先检查相关代码，然后进行修改和验证。',
    terminalStatus: 'completed' as const,
    toolActivityObserved: false,
    explicitFinalReplyObserved: false,
    isLocal: false,
    ...overrides,
  };
}

describe('premature completion guard', () => {
  it('flags a TraeX execution turn that only promises future work', () => {
    expect(shouldRecoverPrematureCompletion(candidate())).toEqual({
      recover: true,
      errorCode: PREMATURE_COMPLETION_ERROR_CODE,
    });
  });

  it('recognizes the same high-confidence shape in English', () => {
    expect(shouldRecoverPrematureCompletion(candidate({
      requestText: '<user_message>Fix the failing test and verify the build.</user_message>',
      finalText: "I'll inspect the implementation first, then make the change and run the tests.",
    })).recover).toBe(true);
  });

  it.each([
    '看看线上的反馈，好像有问题。',
    '你现在自己去核查一遍。',
    '请检查当前 PR 的审查意见。',
  ])('recognizes inspection work as an execution request: %s', requestText => {
    expect(shouldRecoverPrematureCompletion(candidate({
      requestText: `<user_message>${requestText}</user_message>`,
      finalText: '我会先检查线上状态和相关反馈，再给出结论。',
    })).recover).toBe(true);
  });

  it.each([
    '我会先定位问题，修复完成后再运行测试。',
    '我会先检查代码，测试通过后再提交。',
    '我会等修完了后再测试。',
  ])('does not mistake a future completion condition for evidence: %s', finalText => {
    expect(shouldRecoverPrematureCompletion(candidate({ finalText })).recover).toBe(true);
  });

  it.each([
    '好的，我接下来会检查并修复。',
    '好的，我接下来去检查修改。',
    '收到，我先看下代码。',
    '没问题，我会排查并修复。',
    '嗯，让我先看看。',
  ])('recognizes a common Chinese comma-prefixed promise: %s', finalText => {
    expect(shouldRecoverPrematureCompletion(candidate({ finalText })).recover).toBe(true);
  });

  it.each([
    {
      name: 'plan-only request',
      requestText: '<user_message>先给我一个修复计划，不要修改代码，等我确认。</user_message>',
      finalText: '我会先定位调用链，再补测试，最后修改实现。',
    },
    {
      name: 'plan-only request without an explicit no-execute clause',
      requestText: '<user_message>给我一个修复计划和验证步骤。</user_message>',
      finalText: '我会先定位调用链，再补测试，最后修改实现。',
    },
    {
      name: 'English plan-only prefix',
      requestText: '<user_message>Plan only: fix the failing test and verify the build.</user_message>',
      finalText: "I'll inspect the implementation, then change it and run the tests.",
    },
    {
      name: 'explanation request',
      requestText: '<user_message>告诉我为什么这个任务会提前结束？</user_message>',
      finalText: '这是因为单轮终态被错误当成了目标完成。',
    },
    {
      name: 'capability question mentioning a fix',
      requestText: '<user_message>你这个修复能不能解决提前结束的问题？</user_message>',
      finalText: '我会先核对改动范围，再判断它能否解决。',
    },
    {
      name: 'completed evidence',
      requestText: '<user_message>修复这个问题并运行测试。</user_message>',
      finalText: '已修复状态判断，相关 12 个测试全部通过。',
    },
    {
      name: 'colloquial fixed result',
      requestText: '<user_message>修复这个问题并运行测试。</user_message>',
      finalText: '我接下来会说明细节，不过问题已经修完了。',
    },
    {
      name: 'colloquial done result',
      requestText: '<user_message>修复这个问题并运行测试。</user_message>',
      finalText: '收到，我先总结结果：问题已经搞定了。',
    },
    {
      name: 'colloquial ready result',
      requestText: '<user_message>修复这个问题并运行测试。</user_message>',
      finalText: '好的，我会给出变更摘要，代码已经弄好了。',
    },
  ])('does not flag $name', ({ requestText, finalText }) => {
    expect(shouldRecoverPrematureCompletion(candidate({ requestText, finalText })).recover).toBe(false);
  });

  it('requires zero tool activity and no explicit reply', () => {
    expect(shouldRecoverPrematureCompletion(candidate({ toolActivityObserved: true })).recover).toBe(false);
    expect(shouldRecoverPrematureCompletion(candidate({ explicitFinalReplyObserved: true })).recover).toBe(false);
  });

  it('is scoped to successful ordinary TraeX turns', () => {
    expect(shouldRecoverPrematureCompletion(candidate({ cliId: 'codex' })).recover).toBe(false);
    expect(shouldRecoverPrematureCompletion(candidate({ turnId: 'trigger:external' })).recover).toBe(false);
    expect(shouldRecoverPrematureCompletion(candidate({ terminalStatus: 'failed' })).recover).toBe(false);
    expect(shouldRecoverPrematureCompletion(candidate({ dispatchAttempt: 1 })).recover).toBe(false);
    expect(shouldRecoverPrematureCompletion(candidate({ isLocal: true })).recover).toBe(false);
  });

  it.each([
    {
      turnId: 'bmx-recovery-once',
      requestText: PREMATURE_COMPLETION_RECOVERY_PROMPT,
    },
    {
      turnId: 'schedule:task-id:continuation',
      requestText: PREMATURE_COMPLETION_RECOVERY_PROMPT,
    },
    {
      turnId: 'bmx-recovery-provider',
      requestText: ORDINARY_TURN_RECOVERY_PROMPT,
    },
    {
      turnId: 'schedule:task-id:provider-continuation',
      requestText: ORDINARY_TURN_RECOVERY_PROMPT,
    },
  ])('does not recursively guard a recovery request: $turnId', ({ turnId, requestText }) => {
    expect(shouldRecoverPrematureCompletion(candidate({
      turnId,
      requestText,
    })).recover).toBe(false);
  });
});
