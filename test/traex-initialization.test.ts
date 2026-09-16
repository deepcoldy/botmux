import { describe, expect, it } from 'vitest';
import {
  buildTraexInitializationPrompt,
  composeTraexPendingPrompt,
  normalizeTraexInitialPrompt,
  normalizeTraexInitializationMode,
  TRAEX_INITIAL_PROMPT_MAX_LENGTH,
} from '../src/core/traex-initialization.js';

describe('TraeX 初始化提示词', () => {
  it('普通 TraeX 保留用户提示词，Forge 模式增加显式触发词', () => {
    expect(buildTraexInitializationPrompt('traex', '修复登录问题')).toBe('修复登录问题');
    expect(buildTraexInitializationPrompt('forge-pipeline', '修复登录问题'))
      .toBe('$forge-pipeline\n修复登录问题');
    expect(buildTraexInitializationPrompt('forge-pilot', '重构审批模块'))
      .toBe('$forge-pilot\n重构审批模块');
  });

  it('保留 Botmux 首轮可信前缀，只替换用户任务部分', () => {
    expect(composeTraexPendingPrompt('[引用上下文]\n', 'forge-pipeline', '任务'))
      .toBe('[引用上下文]\n$forge-pipeline\n任务');
  });

  it('校验空值、长度和运行方式白名单', () => {
    expect(normalizeTraexInitialPrompt('   ')).toEqual({ ok: false, error: 'empty' });
    expect(normalizeTraexInitialPrompt(` ${'x'.repeat(TRAEX_INITIAL_PROMPT_MAX_LENGTH)} `))
      .toEqual({ ok: true, prompt: 'x'.repeat(TRAEX_INITIAL_PROMPT_MAX_LENGTH) });
    expect(normalizeTraexInitialPrompt('x'.repeat(TRAEX_INITIAL_PROMPT_MAX_LENGTH + 1)))
      .toEqual({ ok: false, error: 'too_long' });
    expect(normalizeTraexInitializationMode('forge-pipeline')).toBe('forge-pipeline');
    expect(normalizeTraexInitializationMode('forge-code-review')).toBeNull();
  });
});
