/**
 * Bot 配置页「Codex 原生归档」区块：按 Bot 覆盖全局 sessionCleanup.archiveCodex。
 *  - 三态：跟随全局（选项里写出全局当前值）/ 本 Bot 开启 / 本 Bot 关闭；
 *  - 开、关都显式提交布尔，只有「跟随全局」提交 null（删除覆盖）；
 *  - 保存失败回滚到原选项、不改本地 bot 数据；bot 数据变化时同步选中项。
 */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { CodexArchiveSection } from '../src/dashboard/web/bot-defaults-page.js';
import { t } from '../src/dashboard/web/ui.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function render(bot: Record<string, unknown>, responses: Array<{ status?: number; body: Record<string, unknown> }>) {
  const calls: Array<{ url: string; method?: string; body: unknown }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const next = responses.shift() ?? { body: { ok: true } };
    const status = next.status ?? 200;
    return { ok: status < 400, status, json: async () => next.body };
  }) as unknown as typeof fetch;
  const patchBot = vi.fn();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const props = (next: Record<string, unknown>) => ({ bot: { larkAppId: 'cli_archive', cliId: 'codex', ...next }, patchBot });
  act(() => { renderer = TestRenderer.create(createElement(CodexArchiveSection, props(bot) as any)); });
  const select = () => renderer!.root.findByProps({ 'data-input': 'archiveCodex' });
  return {
    calls,
    patchBot,
    select,
    status: () => renderer!.root.findByProps({ 'data-archive-codex-status': '' }).children.join(''),
    choose: async (value: string) => {
      await act(async () => { await select().props.onChange({ currentTarget: { value } }); });
    },
    rerender: (next: Record<string, unknown>) => act(() => { renderer!.update(createElement(CodexArchiveSection, props(next) as any)); }),
    unmount() { act(() => renderer!.unmount()); globalThis.fetch = previousFetch; },
  };
}

describe('CodexArchiveSection', () => {
  it('shows the inherited global value and saves explicit on/off as booleans, follow-global as null', async () => {
    const h = render({ archiveCodex: null, archiveCodexDefault: true }, [
      { body: { ok: true, archiveCodex: false } },
      { body: { ok: true, archiveCodex: true } },
      { body: { ok: true, archiveCodex: null } },
    ]);
    try {
      expect(h.select().props.value).toBe('inherit');
      const inherit = h.select().findAllByType('option').find(option => option.props.value === 'inherit')!;
      expect(inherit.children.join('')).toBe(t('botDefaults.archiveCodexInherit', { state: t('botDefaults.archiveCodexStateOn') }));

      await h.choose('off');
      expect(h.calls[0]).toEqual({ url: '/api/bots/cli_archive/archive-codex', method: 'PUT', body: { archiveCodex: false } });
      expect(h.patchBot).toHaveBeenLastCalledWith('cli_archive', { archiveCodex: false });
      expect(h.select().props.value).toBe('off');

      await h.choose('on');
      expect(h.calls[1]!.body).toEqual({ archiveCodex: true });
      expect(h.patchBot).toHaveBeenLastCalledWith('cli_archive', { archiveCodex: true });

      await h.choose('inherit');
      expect(h.calls[2]!.body).toEqual({ archiveCodex: null });
      expect(h.patchBot).toHaveBeenLastCalledWith('cli_archive', { archiveCodex: null });
      expect(h.select().props.value).toBe('inherit');
    } finally { h.unmount(); }
  });

  it('rolls back to the previous choice when the daemon rejects the save', async () => {
    const h = render({ archiveCodex: true, archiveCodexDefault: false }, [
      { status: 400, body: { ok: false, error: 'invalid_archive_codex' } },
    ]);
    try {
      expect(h.select().props.value).toBe('on');
      await h.choose('off');
      expect(h.select().props.value).toBe('on');
      expect(h.patchBot).not.toHaveBeenCalled();
      expect(h.status()).toContain('✗');
    } finally { h.unmount(); }
  });

  it('follows the bot data when it changes elsewhere (e.g. /config set)', () => {
    const h = render({ archiveCodex: null, archiveCodexDefault: false }, []);
    try {
      const inherit = h.select().findAllByType('option').find(option => option.props.value === 'inherit')!;
      expect(inherit.children.join('')).toBe(t('botDefaults.archiveCodexInherit', { state: t('botDefaults.archiveCodexStateOff') }));
      h.rerender({ archiveCodex: false, archiveCodexDefault: false });
      expect(h.select().props.value).toBe('off');
      expect(h.calls).toHaveLength(0);
    } finally { h.unmount(); }
  });
});
