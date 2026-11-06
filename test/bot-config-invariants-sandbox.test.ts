import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

  it('under scratch rejects only CLIs that have transcript capture but lose it there (cursor/doubao); never-capture CLIs stay editable', () => {
    // #2828 复审 P3 再收窄：opencode/codex-app/antigravity 是「从来没有」转写采集，
    // scratch 下显式 transcript 也只是运行时回落 send，不静默。该形状在 master 可达
    //（{codex,scratch,transcript} 切 cliId 到这些 CLI 时 master invariant 放行），
    // 存量 bots.json 里可能存在；锁它的编辑没有收益。
    expect(botConfigInvariantError({
      cliId: 'opencode', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'codex-app', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'antigravity', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBeUndefined();
    // 真静默边：本有采集、scratch 让宿主桥读不到
    expect(botConfigInvariantError({
      cliId: 'doubao', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBe('reply_delivery_unsupported');
    expect(botConfigInvariantError({
      cliId: 'cursor', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBe('reply_delivery_unsupported');
    // 本就支持且 scratch 不影响的 CLI 放行；修复出口（显式 send / 未配置）放行
    expect(botConfigInvariantError({
      cliId: 'codex', replyDelivery: 'transcript', sandbox: 'scratch',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'opencode', replyDelivery: 'send', sandbox: 'scratch',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'opencode', sandbox: 'scratch',
    })).toBeUndefined();
    expect(botConfigInvariantError({
      cliId: 'doubao', sandbox: 'scratch',
    })).toBeUndefined();
  });

  // 源码结构护栏(K1)：invariants 处在 config-store→invariants→…→bot-registry 环的一边，
  // 从 core/reply-delivery 导入能力判据会把环闭成 bun 模块链接期错误（CI bun-test
  // summary-command-window 实测），vitest 对环宽容、行为测试测不出来，只能钉 import 边。
  it('K2 结构护栏：invariants 不得经 core/reply-delivery 取能力判据（会闭合 bun 链接期环）', () => {
    // bot-registry → turn-reply-card → card-handler → bot-config-store →
    // config-store → invariants 已在环的一边；reply-delivery 又直接 import
    // bot-registry。invariants 从 reply-delivery 导入会让 bun 在模块链接期报
    // "Export named 'resolveReplyDelivery' not found"（CI bun-test
    // summary-command-window 实测，vitest 对环宽容测不出来，只能守依赖边）。
    // 能力判据在 core/zero-prompt-support（叶子模块），从那里或
    // structured-bridge-clis 取。
    const source = readFileSync(
      fileURLToPath(new URL('../src/services/bot-config-invariants.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"][^'"]*core\/reply-delivery(\.js)?['"]/);
    expect(source).toMatch(/from\s+['"][^'"]*core\/zero-prompt-support(\.js)?['"]/);
  });
});
