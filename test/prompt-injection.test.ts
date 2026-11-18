/**
 * `src/core/prompt-injection.ts` 纯能力闸口：哪些 CLI 支持零注入（自动获取最终回复）。
 *
 * Run: vitest run --project unit test/prompt-injection.test.ts
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => { throw new Error('not configured'); }),
}));

import { supportsZeroPromptInjection, sessionPromptInjection, isScratchSandbox } from '../src/core/prompt-injection.js';

describe('supportsZeroPromptInjection', () => {
  it('supports the classic transcript CLIs', () => {
    expect(supportsZeroPromptInjection('claude-code')).toBe(true);
    expect(supportsZeroPromptInjection('codex')).toBe(true);
    expect(supportsZeroPromptInjection('grok')).toBe(true);
  });

  it('supports cursor and antigravity', () => {
    expect(supportsZeroPromptInjection('cursor')).toBe(true);
    expect(supportsZeroPromptInjection('antigravity')).toBe(true);
  });

  it('keeps CLIs without a transcript bridge unsupported', () => {
    expect(supportsZeroPromptInjection('opencode')).toBe(false);
    expect(supportsZeroPromptInjection('kimi')).toBe(false);
    expect(supportsZeroPromptInjection(undefined)).toBe(false);
  });

  it('rejects remote backends even for otherwise-capable CLIs', () => {
    expect(supportsZeroPromptInjection('cursor', { backendType: 'pty' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { backendType: 'tmux' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { backendType: 'riff' })).toBe(false);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'mojo' })).toBe(false);
    expect(supportsZeroPromptInjection('codex', { backendType: 'riff' })).toBe(false);
  });

  it('supports antigravity and cursor on zmx, while rejecting zmx + scratch', () => {
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'zmx' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'zmx', sandbox: false })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'zmx', sandbox: 'oncall' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'zmx', sandbox: 'scratch' })).toBe(false);
    expect(supportsZeroPromptInjection('cursor', { backendType: 'zmx' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'zellij' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { backendType: 'tmux' })).toBe(true);
  });

  it('isScratchSandbox only recognises the tri-state scratch value', () => {
    expect(isScratchSandbox({ sandbox: 'scratch' })).toBe(true);
    expect(isScratchSandbox({ sandbox: 'oncall' })).toBe(false);
    expect(isScratchSandbox({ sandbox: true })).toBe(false);
    expect(isScratchSandbox({ sandbox: false })).toBe(false);
    expect(isScratchSandbox({ readIsolation: true })).toBe(false);
    expect(isScratchSandbox({})).toBe(false);
  });

  it('allows cursor/antigravity/doubao under the oncall bwrap sandbox (transcript dirs are directory-bound to the host fs)', () => {
    // ~/.cursor / ~/.gemini / ~/.local/share/doubao_cli are adapter authPaths →
    // real --bind in the oncall bwrap, so the daemon reads the same transcript
    // paths the CLI writes.
    expect(supportsZeroPromptInjection('cursor', { sandbox: true })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { sandbox: 'oncall' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: true, backendType: 'tmux' })).toBe(true);
    expect(supportsZeroPromptInjection('doubao', { sandbox: true })).toBe(true);
    expect(supportsZeroPromptInjection('doubao', { sandbox: 'oncall' })).toBe(true);
    expect(supportsZeroPromptInjection('cursor', { readIsolation: true })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: false, readIsolation: true })).toBe(true);
  });

  it('allows antigravity under scratch (pty/tmux) while keeping cursor/doubao and non-pty/tmux scratch combinations rejected', () => {
    expect(supportsZeroPromptInjection('cursor', { sandbox: 'scratch' })).toBe(false);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'scratch' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'scratch', backendType: 'pty' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'scratch', backendType: 'tmux' })).toBe(true);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'scratch', backendType: 'zmx' })).toBe(false);
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'scratch', backendType: 'zellij' })).toBe(false);
    // #2828: doubao 的 .sessions 树没有 scratch host-view 映射，零注入会强制
    // transcript 而桥读不到 merged 树 → 整轮静默，写配置/ spawn 两处都必须拒。
    expect(supportsZeroPromptInjection('doubao', { sandbox: 'scratch' })).toBe(false);
    // Explicit off is fine.
    expect(supportsZeroPromptInjection('antigravity', { sandbox: 'off' })).toBe(true);
    expect(supportsZeroPromptInjection('doubao', { sandbox: 'off' })).toBe(true);
    expect(supportsZeroPromptInjection('codex', { sandbox: 'scratch' })).toBe(true);
  });
});

describe('sessionPromptInjection', () => {
  it('prefers the live session value, then init config, then default', () => {
    expect(sessionPromptInjection({ session: { promptInjection: 'none' }, initConfig: { promptInjection: 'default' } } as any)).toBe('none');
    expect(sessionPromptInjection({ session: {}, initConfig: { promptInjection: 'none' } } as any)).toBe('none');
    expect(sessionPromptInjection({ session: {}, initConfig: {} } as any)).toBe('default');
  });
});
