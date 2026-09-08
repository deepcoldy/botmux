import { describe, expect, it } from 'vitest';
import { cloneBotConfig } from '../src/setup/bot-config-editor.js';
import { applyCloneDefaults, cloneSourceDefaultsFrom } from '../src/dashboard/web/bot-onboarding.js';

/**
 * Dashboard 克隆弹窗的表单预填。
 *
 * 后端 cloneBotConfig 会用源 Bot 覆盖 cliId / 目录 / model，所以表单必须显示
 * **真正会生效的**那份，否则用户填了却被静默丢弃。目录尤其要区分两种互斥形态：
 * 源只有 workingDir 时若仍按 fixed 预填，目标会带上 defaultWorkingDir，在后端
 * `defaultWorkingDir ?? workingDir` 里反过来把源目录遮蔽掉（见最后一组用例）。
 */
const baseForm = {
  appName: '',
  cliId: 'claude-code',
  workingDir: '~',
  dirMode: 'fixed' as const,
  model: '',
};

describe('clone 预填：applyCloneDefaults', () => {
  it('没有克隆源时原样返回表单默认值', () => {
    expect(applyCloneDefaults(baseForm as any, undefined)).toEqual(baseForm);
  });

  it('用源 Bot 的值覆盖，未提供的项保持表单默认', () => {
    const next = applyCloneDefaults(baseForm as any, { cliId: 'codex', model: 'opus' });
    expect(next.cliId).toBe('codex');
    expect(next.model).toBe('opus');
    // 源没给目录 → 保持默认，不臆造。
    expect(next.workingDir).toBe('~');
    expect(next.dirMode).toBe('fixed');
  });

  it('源是 card 形态时把 dirMode 一并带过来', () => {
    const next = applyCloneDefaults(baseForm as any, { workingDir: '/repo/app', dirMode: 'card' });
    expect(next.workingDir).toBe('/repo/app');
    expect(next.dirMode).toBe('card');
  });
});

describe('clone 预填：cloneSourceDefaultsFrom（源配置行 → 表单预填值）', () => {
  it('没选到源时返回 undefined', () => {
    expect(cloneSourceDefaultsFrom(undefined)).toBeUndefined();
  });

  it('源用 defaultWorkingDir → fixed 形态', () => {
    expect(cloneSourceDefaultsFrom({ cliId: 'codex', defaultWorkingDir: '/repo/fixed-one' }))
      .toEqual({ cliId: 'codex', workingDir: '/repo/fixed-one', dirMode: 'fixed' });
  });

  it('源只有 workingDir → card 形态（不能一律 fixed，否则源目录会被 ~ 遮蔽）', () => {
    expect(cloneSourceDefaultsFrom({ cliId: 'codex', workingDir: '/repo/my-project' }))
      .toEqual({ cliId: 'codex', workingDir: '/repo/my-project', dirMode: 'card' });
  });

  it('两个目录字段都在时以 defaultWorkingDir 为准（与后端取值顺序一致）', () => {
    expect(cloneSourceDefaultsFrom({ defaultWorkingDir: '/repo/fixed', workingDir: '/repo/card' }))
      .toEqual({ workingDir: '/repo/fixed', dirMode: 'fixed' });
  });

  it('源没有目录时不臆造目录项', () => {
    expect(cloneSourceDefaultsFrom({ cliId: 'codex', model: 'opus' }))
      .toEqual({ cliId: 'codex', model: 'opus' });
  });

  it('null/空串一律当作未设置', () => {
    expect(cloneSourceDefaultsFrom({ cliId: null, defaultWorkingDir: null, workingDir: '', model: null }))
      .toEqual({});
  });
});

describe('clone 目录形态：源目录不能被目标的默认值遮蔽', () => {
  /** 后端 run() 里决定新会话工作目录的那一步。 */
  const effectiveDir = (bot: Record<string, any>): string =>
    bot.defaultWorkingDir ?? bot.workingDir ?? '~';

  /** 表单 dirMode 决定目标 bot 落哪个目录字段（与 bot-onboarding.run 一致）。 */
  const targetFromForm = (dirMode: 'card' | 'fixed', dir: string): Record<string, any> => ({
    larkAppId: 'cli_target',
    larkAppSecret: 'target-secret',
    ...(dirMode === 'fixed' ? { defaultWorkingDir: dir } : { workingDir: dir }),
  });

  it('源用 workingDir（card 形态）时，按源形态预填后目录不被遮蔽', () => {
    const source = { larkAppId: 'cli_source', cliId: 'codex', workingDir: '/repo/my-project' };
    // 走真实映射函数（而不是手喂 dirMode），这样「页面接线退回一律 fixed」也会被抓到。
    const prefilled = applyCloneDefaults(baseForm as any, cloneSourceDefaultsFrom(source));
    const bot = cloneBotConfig(source, targetFromForm(prefilled.dirMode, prefilled.workingDir));
    expect(effectiveDir(bot)).toBe('/repo/my-project');
  });

  it('源用 defaultWorkingDir（fixed 形态）时同样保留源目录', () => {
    const source = { larkAppId: 'cli_source', cliId: 'codex', defaultWorkingDir: '/repo/fixed-one' };
    const prefilled = applyCloneDefaults(baseForm as any, cloneSourceDefaultsFrom(source));
    const bot = cloneBotConfig(source, targetFromForm(prefilled.dirMode, prefilled.workingDir));
    expect(effectiveDir(bot)).toBe('/repo/fixed-one');
  });

  it('回归：源只有 workingDir 却按 fixed 建目标时，源目录会被 ~ 遮蔽', () => {
    // 这一条固定住 bug 本身的机制——修复是「按源形态预填」，而不是改 cloneBotConfig。
    // 若哪天预填分支被删回「一律 fixed」，上面第一条会红，这条解释为什么。
    const source = { larkAppId: 'cli_source', cliId: 'codex', workingDir: '/repo/my-project' };
    const bot = cloneBotConfig(source, targetFromForm('fixed', '~'));
    expect(bot.workingDir).toBe('/repo/my-project');
    expect(effectiveDir(bot)).toBe('~');
  });
});

describe('clone native subagent runtime policy', () => {
  it('copies the policy as behavior configuration', () => {
    const nativeSubagentRuntime = {
      model: { mode: 'custom', value: 'GPT-5.6-Sol' },
      reasoningEffort: { mode: 'custom', value: 'high' },
    };
    const cloned = cloneBotConfig(
      { larkAppId: 'cli_source', nativeSubagentRuntime },
      { larkAppId: 'cli_target', larkAppSecret: 'target-secret' },
    );
    expect(cloned.nativeSubagentRuntime).toEqual(nativeSubagentRuntime);
  });
});
