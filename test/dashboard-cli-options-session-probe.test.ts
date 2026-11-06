/**
 * dashboard-cli-options-session-probe.test.ts
 *
 * `/api/cli-options` 的登录态探测（`botOnboarding.sessionStatus()`）是一趟到飞书
 * 开放平台的真实网络往返（实测 1-4s），而 Bot 配置页的 `CliOptionsState` 用不到
 * `webSession`。服务端裸端点保留旧语义（照旧探测），只有显式 `?probe=none` 才跳过；
 * Bot 配置页必须带上它走快路径，否则首屏又退回 1-4s。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCliOptions } from '../src/dashboard/web/bot-defaults.js';

describe('Bot 配置页 fetchCliOptions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('显式请求 ?probe=none，跳过开放平台登录态探测', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        options: [{ id: 'codex', label: 'Codex', modelChoices: ['gpt-5.2'] }],
        ttadkModelDefault: 'glm-5.1',
        ttadkModelSuggestions: [],
      }),
    }));
    vi.stubGlobal('fetch', fetchSpy);

    const state = await fetchCliOptions();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith('/api/cli-options?probe=none');
    expect(state.options.map(o => o.id)).toEqual(['codex']);
  });
});
