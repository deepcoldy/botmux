import { describe, expect, it } from 'vitest';
import { botConfigInvariantError } from '../src/services/bot-config-invariants.js';

describe('botConfigInvariantError — sandbox tri-state', () => {
  it('leaves a normal entry alone', () => {
    expect(botConfigInvariantError({ cliId: 'codex-app' })).toBeUndefined();
    expect(botConfigInvariantError({ cliId: 'codex-app', sandbox: false })).toBeUndefined();
    expect(botConfigInvariantError({ cliId: 'codex-app', sandbox: 'off' })).toBeUndefined();
  });

  it('flags codexBrowser combined with every active sandbox representation', () => {
    const base = { cliId: 'codex-app', codexBrowser: { enabled: true } };
    expect(botConfigInvariantError({ ...base, sandbox: true })).toBe('codex_browser_config_conflict');
    expect(botConfigInvariantError({ ...base, sandbox: 'oncall' })).toBe('codex_browser_config_conflict');
    // Mutation-guard: the scratch string must count as an active sandbox — a
    // `=== true`-only check would let a scratch bot enable codexBrowser.
    expect(botConfigInvariantError({ ...base, sandbox: 'scratch' })).toBe('codex_browser_config_conflict');
    expect(botConfigInvariantError({ ...base, readIsolation: true })).toBe('codex_browser_config_conflict');
  });

  it('still allows codexBrowser when the sandbox is explicitly off', () => {
    expect(botConfigInvariantError({
      cliId: 'codex-app',
      codexBrowser: { enabled: true },
      sandbox: 'off',
    })).toBeUndefined();
  });

  it('flags existingAppServer combined with scratch/oncall', () => {
    expect(botConfigInvariantError({
      cliId: 'codex',
      existingAppServer: { endpoint: 'http://x' },
      sandbox: 'scratch',
    })).toBe('existing_app_server_sandbox_conflict');
    expect(botConfigInvariantError({
      cliId: 'codex',
      existingAppServer: { endpoint: 'http://x' },
      sandbox: 'oncall',
    })).toBe('existing_app_server_sandbox_conflict');
    expect(botConfigInvariantError({
      cliId: 'codex',
      existingAppServer: { endpoint: 'http://x' },
      sandbox: 'off',
    })).toBeUndefined();
  });

  it('keeps the codex-app cliId requirement', () => {
    expect(botConfigInvariantError({ cliId: 'codex', codexBrowser: true }))
      .toBe('codex_browser_requires_codex_app');
  });

  it('flags cursor transcript delivery under scratch (host bridge cannot read the merged overlay mirror)', () => {
    // 变异护栏：三个条件缺一不可——少任何一个都不该拦（codex scratch 合法、
    // cursor oncall 合法、cursor scratch 下 send 合法）。
    expect(botConfigInvariantError({
      cliId: 'cursor', sandbox: 'scratch', replyDelivery: 'transcript',
    })).toBe('reply_delivery_unsupported');
    expect(botConfigInvariantError({
      cliId: 'codex', sandbox: 'scratch', replyDelivery: 'transcript',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'cursor', sandbox: 'oncall', replyDelivery: 'transcript',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'cursor', sandbox: true, replyDelivery: 'transcript',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'cursor', sandbox: 'scratch', replyDelivery: 'send',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'cursor', sandbox: 'scratch',
    })).toBeUndefined();
  });

  it('flags doubao transcript delivery under scratch (#2828: .sessions tree lands in the merged overlay; default/unset stays writable)', () => {
    // doubao 缺省 transcript 但缺省不落盘：未写 replyDelivery 的 entry 必须放行
    //（运行时回落 send），只有显式 transcript 才拒。
    expect(botConfigInvariantError({
      cliId: 'doubao', sandbox: 'scratch', replyDelivery: 'transcript',
    })).toBe('reply_delivery_unsupported');
    expect(botConfigInvariantError({
      cliId: 'doubao', sandbox: 'scratch', replyDelivery: 'send',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'doubao', sandbox: 'scratch',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'doubao', sandbox: 'oncall', replyDelivery: 'transcript',
    })).toBeUndefined();
  });

  it('does NOT reject persisted transcript on non-transcript CLIs outside scratch (runtime falls back to send; never lock unrelated edits)', () => {
    // #2828 复审 P2：把判据泛化成「任何无转写能力 CLI × 显式 transcript」会锁死存量
    // entry（从 claude-code 切 cliId 到达的形状，master 历来放行，运行时回落 send）。
    // 不变量只拦 scratch：非 scratch（含 oncall）下这些 entry 必须继续放行。
    for (const cliId of ['opencode', 'codex-app', 'antigravity']) {
      expect(botConfigInvariantError({
        cliId, replyDelivery: 'transcript', model: 'old',
      })).toBeUndefined();
      expect(botConfigInvariantError({
        cliId, replyDelivery: 'transcript', sandbox: 'oncall',
      })).toBeUndefined();
    }
  });

  it('rejects persisted transcript for any non-capture CLI under scratch while the repair exits stay open', () => {
    // 窄化后的判据在 scratch 下对任何无采集 CLI 都成立：{unsupported cli, scratch,
    // transcript} 无法经 cliId/sandbox 切换落成；切回支持的 CLI、显式 send、关掉
    // scratch 三个修复出口仍可走。
    expect(botConfigInvariantError({
      cliId: 'opencode', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBe('reply_delivery_unsupported');
    expect(botConfigInvariantError({
      cliId: 'antigravity', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBe('reply_delivery_unsupported');
    expect(botConfigInvariantError({
      cliId: 'opencode', replyDelivery: 'send', sandbox: 'scratch',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'opencode', sandbox: 'scratch',
    })).toBeUndefined();
  });
});
