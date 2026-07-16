import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  VcConsumerProfilesGate,
  VcConsumerProfilesSection,
} from '../src/dashboard/web/vc-consumer-profiles-section.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Json = Record<string, unknown>;

interface Deferred {
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

function defer(): Deferred {
  let resolve!: (value: unknown) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonRes(status: number, body: Json) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function profileDto(id: string, over: Json = {}): Json {
  return { id, agentAppId: 'app_agent', responseMode: 'silent', permissionPreset: 'observe_only', ...over };
}

function catalogBody(bot: string, over: Json = {}): Json {
  return {
    ok: true,
    listenerBotAppId: bot,
    revision: `rev-${bot}-1`,
    catalogState: 'profiles',
    defaultMode: 'listenOnly',
    defaultConsumerIds: [],
    profiles: [profileDto(`${bot}-profile`)],
    agentOptions: [{
      appId: 'app_agent', label: 'Agent', online: true, workingDirReady: true, reliableTurnTerminal: true,
      managedSideEffectIsolation: true,
    }],
    ...over,
  };
}

const TWO_BOTS = [
  { larkAppId: 'A', botName: 'Bot A' },
  { larkAppId: 'B', botName: 'Bot B' },
];

function sectionProps(over: Json = {}) {
  return {
    canWrite: true,
    listenerBotAppId: 'A',
    listenerBotOptions: TWO_BOTS,
    ...over,
  };
}

async function mount(over: Json = {}): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(VcConsumerProfilesSection, sectionProps(over) as never),
    );
  });
  return renderer;
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
});

function textOf(node: TestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: unknown): void => {
    if (typeof child === 'string') parts.push(child);
    else if (child && typeof child === 'object' && 'children' in (child as never)) {
      for (const grand of (child as TestRenderer.ReactTestInstance).children) walk(grand);
    }
  };
  for (const child of node.children) walk(child);
  return parts.join('');
}

function textInputs(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return r.root.findAllByType('input').filter(input => input.props.type === 'text');
}

/** 每张卡两个文本框（id、label）：idInput(n) 取第 n 张卡的 id 输入框。 */
function idInput(r: TestRenderer.ReactTestRenderer, card: number): TestRenderer.ReactTestInstance {
  return textInputs(r)[card * 2];
}

function labelInput(r: TestRenderer.ReactTestRenderer, card: number): TestRenderer.ReactTestInstance {
  return textInputs(r)[card * 2 + 1];
}

function buttonByClass(
  r: TestRenderer.ReactTestRenderer, cls: string,
): TestRenderer.ReactTestInstance | undefined {
  return r.root.findAllByType('button')
    .find(button => String(button.props.className ?? '').split(' ').includes(cls));
}

function saveButton(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance | undefined {
  return buttonByClass(r, 'vc-profiles-save');
}

/** 「新增预设」按钮：className 恰为 vc-profiles-link（remove/reload 带附加类）。 */
function addButton(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance | undefined {
  return r.root.findAllByType('button')
    .find(button => String(button.props.className ?? '') === 'vc-profiles-link');
}

function optionButton(
  r: TestRenderer.ReactTestRenderer, label: string,
): TestRenderer.ReactTestInstance | undefined {
  return r.root.findAllByType('button').find(button => textOf(button) === label);
}

function clickOption(button: TestRenderer.ReactTestInstance): Promise<void> {
  return act(async () => {
    button.props.onClick({ currentTarget: { closest: () => ({ removeAttribute: vi.fn() }) } });
  });
}

function setInput(input: TestRenderer.ReactTestInstance, value: string): Promise<void> {
  return act(async () => { input.props.onChange({ target: { value } }); });
}

/** defaultConsumerIds 勾选框：文本恰为 profile id/label 的 vc-profile-check。 */
function defaultConsumerCheckbox(
  r: TestRenderer.ReactTestRenderer, label: string,
): TestRenderer.ReactTestInstance | undefined {
  const holder = r.root.findAll(node =>
    node.type === 'label'
    && String(node.props.className ?? '') === 'vc-profile-check'
    && textOf(node) === label)[0];
  return holder?.findByType('input');
}

function putCalls(fetchMock: ReturnType<typeof vi.fn>): Json[] {
  return fetchMock.mock.calls
    .filter(call => (call[1] as RequestInit | undefined)?.method === 'PUT')
    .map(call => JSON.parse(String((call[1] as RequestInit).body)) as Json);
}

let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirmMock = vi.fn(() => true);
  vi.stubGlobal('window', { confirm: confirmMock });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 简单场景通用 fetch：GET 按 bot 回 catalog，PUT 由调用方指定。 */
function stubFetchImmediate(
  catalogs: Record<string, Json>,
  onPut: () => unknown = () => jsonRes(200, catalogBody('A')),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') return onPut();
    const bot = new URL(String(url), 'http://h').searchParams.get('listenerBotAppId') ?? '';
    const body = catalogs[bot];
    return body ? jsonRes(200, body) : jsonRes(404, { ok: false, error: 'bot_not_in_config' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('VcConsumerProfilesSection · 加载与竞态', () => {
  // codex 指定用例：A 慢 / B 快乱序——慢 A 响应绝不能覆盖已提交的 B catalog。
  it('discards a stale slow load(A) response after switching to B', async () => {
    const gets = new Map<string, Deferred>();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve(jsonRes(200, catalogBody('B', { revision: 'rev-B-2' })));
      }
      const bot = new URL(String(url), 'http://h').searchParams.get('listenerBotAppId') ?? '';
      const d = defer();
      gets.set(bot, d);
      return d.promise;
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await mount();
    expect(gets.has('A')).toBe(true);
    // 全局设置切到 B（未 dirty → 自动跟随），A 的 GET 仍悬挂
    await act(async () => { r.update(React.createElement(VcConsumerProfilesSection, sectionProps({ listenerBotAppId: 'B' }) as never)); });
    expect(gets.has('B')).toBe(true);

    // B 先返回并提交
    gets.get('B')!.resolve(jsonRes(200, catalogBody('B')));
    await flush();
    expect(idInput(r, 0).props.value).toBe('B-profile');

    // 慢 A 随后返回：token 已过期，必须被丢弃
    gets.get('A')!.resolve(jsonRes(200, catalogBody('A')));
    await flush();
    expect(idInput(r, 0).props.value).toBe('B-profile');
    expect(saveButton(r)).toBeTruthy();
    expect(saveButton(r)!.props.disabled).toBe(true); // 未 dirty

    // 接着编辑并保存：PUT 必须归属 B 的 catalog（forBot + B 的 revision），
    // 证明 stale A 既没污染渲染也没污染保存目标。
    await setInput(labelInput(r, 0), 'edited-on-B');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    const puts = putCalls(fetchMock);
    expect(puts).toHaveLength(1);
    expect(puts[0].listenerBotAppId).toBe('B');
    expect(puts[0].expectedRevision).toBe('rev-B-1');
  });

  it('renders no editor (and no save button) while a load is pending', async () => {
    const d = defer();
    vi.stubGlobal('fetch', vi.fn(() => d.promise));
    const r = await mount();
    expect(saveButton(r)).toBeUndefined();
    expect(textInputs(r)).toHaveLength(0);
    d.resolve(jsonRes(200, catalogBody('A')));
    await flush();
    expect(saveButton(r)).toBeTruthy();
  });

  it('blocks props-driven auto-follow while dirty, then converges after saving', async () => {
    const fetchMock = stubFetchImmediate({ A: catalogBody('A'), B: catalogBody('B') });
    const r = await mount();
    await setInput(labelInput(r, 0), 'edited');

    // props 变更：dirty → 不自动跟随，不发 GET B
    await act(async () => { r.update(React.createElement(VcConsumerProfilesSection, sectionProps({ listenerBotAppId: 'B' }) as never)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(idInput(r, 0).props.value).toBe('A-profile');

    // 先保存 A 的待提交修改；dirty 清除后，显式 listener B 必须自动接管，
    // 否则页面没有 catalog selector，会永久困在旧 listener。
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock)[0]?.listenerBotAppId).toBe('A');
    expect(fetchMock.mock.calls.some(call =>
      !(call[1] as RequestInit | undefined)?.method
      && new URL(String(call[0]), 'http://h').searchParams.get('listenerBotAppId') === 'B'))
      .toBe(true);
    expect(idInput(r, 0).props.value).toBe('B-profile');
  });
});

describe('VcConsumerProfilesSection · Listener 归属与语义文案', () => {
  it('renders an explicit listener as a read-only configuring target', async () => {
    stubFetchImmediate({ A: catalogBody('A') });
    const r = await mount();

    expect(textOf(r.root.findByProps({ className: 'vc-profile-config-target' })))
      .toBe('正在配置：Bot A');
    expect(r.root.findAllByProps({ 'aria-label': '配置所属 Listener' })).toHaveLength(0);
    expect(optionButton(r, 'Bot B')).toBeUndefined();
  });

  it('shows the labeled listener selector only in auto mode and keeps dirty-switch confirmation', async () => {
    const fetchMock = stubFetchImmediate({ A: catalogBody('A'), B: catalogBody('B') });
    const r = await mount({ listenerBotAppId: null });

    expect(r.root.findAllByProps({ 'aria-label': '配置所属 Listener' })).toHaveLength(1);
    expect(textOf(r.root.findByProps({ className: 'vc-profiles-section' })))
      .toContain('配置所属 Listener');

    await setInput(labelInput(r, 0), 'edited');
    confirmMock.mockReturnValueOnce(false);
    await clickOption(optionButton(r, 'Bot B')!);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(labelInput(r, 0).props.value).toBe('edited');

    await clickOption(optionButton(r, 'Bot B')!);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(idInput(r, 0).props.value).toBe('B-profile');
  });

  it('uses disambiguated Bot and no-action labels in both locales', () => {
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');

    expect(zh('settings.vcMeetingListenerBot')).toBe('会议事件接收 Bot');
    expect(en('settings.vcMeetingListenerBot')).toBe('Meeting event receiver Bot');
    expect(zh('settings.vcProfiles.fieldAgent')).toBe('角色执行 Bot');
    expect(en('settings.vcProfiles.fieldAgent')).toBe('Role execution Bot');
    expect(zh('settings.vcProfiles.defaultMode')).toContain('未操作');
    expect(en('settings.vcProfiles.defaultMode')).toContain('no selection');
    expect(zh('settings.vcProfiles.defaultConsumers')).toContain('未操作');
    expect(en('settings.vcProfiles.defaultConsumers')).toContain('no selection');
    expect(zh('settings.vcProfiles.migrationOffer')).toContain('会中文字和语音必须经过受管输出闸门');
    expect(zh('settings.vcProfiles.migrationOffer')).toContain('语音还需 Listener 语音设施已启用');
    expect(en('settings.vcProfiles.migrationOffer')).toContain('listener-thread replies can be sent directly');
    expect(en('settings.vcProfiles.migrationOffer')).toContain('managed output gate');
    expect(en('settings.vcProfiles.migrationOffer')).toContain('requires approval by default');
    expect(zh('settings.vcProfiles.migrationEnable')).toContain('升级并启用全能力默认纪要');
    expect(en('settings.vcProfiles.migrationEnable')).toContain('Upgrade and enable full-capability minutes');
  });
});

describe('VcConsumerProfilesSection · 保存', () => {
  it('offers the exact legacy seed as an explicit full-capability v2 upgrade and saves through the existing PUT', async () => {
    const v2Instructions = '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。仅在出现新的关键决策、明确待办或风险，或被用户点名时，才在监听群输出简洁增量；无实质增量时保持静默，不发送确认或心跳。需要向会议内发送文字或语音时，必须通过 botmux 受管 request-output/action gate 提交，不得绕过权限、所有权与审核策略。';
    const fetchMock = stubFetchImmediate({
      A: catalogBody('A', {
        migrationOffer: 'enable_seeded_minutes_default',
        profiles: [profileDto('minutes', {
          agentAppId: 'app_agent',
          label: '会议纪要',
          instructions: 'legacy instructions',
          activityTypes: ['transcript_received'],
        })],
      }),
    }, () => jsonRes(200, catalogBody('A', {
      revision: 'rev-A-2',
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [profileDto('minutes', {
        label: '会议纪要',
        instructions: v2Instructions,
        activityTypes: ['transcript_received'],
        responseMode: 'listener_thread',
        permissionPreset: 'meeting_text_voice',
      })],
    })));
    const r = await mount();
    expect(textOf(r.root)).toContain('监听群回复可直接发送');
    expect(textOf(r.root)).toContain('会中文字和语音必须经过受管输出闸门');
    const enable = optionButton(r, '升级并启用全能力默认纪要（保存后生效）');
    expect(enable).toBeTruthy();
    await act(async () => { enable!.props.onClick(); });
    expect(defaultConsumerCheckbox(r, '会议纪要')?.props.checked).toBe(true);
    expect(saveButton(r)?.props.disabled).toBe(false);
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock)[0]).toMatchObject({
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [{
        id: 'minutes',
        agentAppId: 'app_agent',
        label: '会议纪要',
        instructions: v2Instructions,
        activityTypes: ['transcript_received'],
        responseMode: 'listener_thread',
        permissionPreset: 'meeting_text_voice',
      }],
    });
    expect(optionButton(r, '升级并启用全能力默认纪要（保存后生效）')).toBeUndefined();
  });

  it('shows an actionable reason when an uninitialized catalog has no eligible execution bot', async () => {
    stubFetchImmediate({
      A: catalogBody('A', {
        catalogState: 'uninitialized',
        profiles: [],
        agentOptions: [{
          appId: 'broken', label: 'Broken', online: true, workingDirReady: false, reliableTurnTerminal: false,
          managedSideEffectIsolation: false,
        }],
      }),
    });
    const r = await mount();
    expect(r.root.findAllByProps({ className: 'hint-warn' })
      .some(node => textOf(node).includes('暂时无法生成默认角色'))).toBe(true);
  });

  it('save posts catalog.forBot + revision; id rename & card removal sync defaultConsumerIds', async () => {
    const fetchMock = stubFetchImmediate({
      A: catalogBody('A', {
        defaultMode: 'agents',
        defaultConsumerIds: ['minutes', 'scribe'],
        profiles: [profileDto('minutes'), profileDto('scribe')],
      }),
    }, () => jsonRes(200, catalogBody('A', { revision: 'rev-A-2' })));
    const r = await mount();

    // 删除 scribe 卡：defaultConsumerIds 同步剔除 'scribe'
    const removeButtons = r.root.findAllByType('button')
      .filter(button => String(button.props.className ?? '').includes('vc-profile-remove'));
    await act(async () => { removeButtons[1].props.onClick(); });

    // 新增预设 → 起名 a → 勾为默认 → 改名 b：默认列表必须跟着换成 b
    await act(async () => { addButton(r)!.props.onClick(); });
    await setInput(idInput(r, 1), 'a');
    await act(async () => {
      defaultConsumerCheckbox(r, 'a')!.props.onChange({ target: { checked: true } });
    });
    await setInput(idInput(r, 1), 'b');

    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    const puts = putCalls(fetchMock);
    expect(puts).toHaveLength(1);
    expect(puts[0].listenerBotAppId).toBe('A');
    expect(puts[0].expectedRevision).toBe('rev-A-1');
    expect(puts[0].defaultConsumerIds).toEqual(['minutes', 'b']);
    expect((puts[0].profiles as Json[]).map(p => p.id)).toEqual(['minutes', 'b']);
  });

  // codex 指定用例：PUT pending 时全部编辑入口冻结（含 add/remove），
  // 成功响应整份替换 catalog 时不存在可被吞掉的进行中编辑。
  it('freezes every edit control while a save is pending, unfreezes on success', async () => {
    const put = defer();
    stubFetchImmediate({ A: catalogBody('A') }, () => put.promise);
    const r = await mount();
    await setInput(labelInput(r, 0), 'edited');

    await act(async () => { saveButton(r)!.props.onClick(); });
    // pending：输入框/textarea/checkbox/add/remove 全部 disabled
    for (const input of r.root.findAllByType('input')) {
      expect(input.props.disabled).toBe(true);
    }
    expect(r.root.findByType('textarea').props.disabled).toBe(true);
    expect(addButton(r)!.props.disabled).toBe(true);
    expect(buttonByClass(r, 'vc-profile-remove')!.props.disabled).toBe(true);
    expect(saveButton(r)!.props.disabled).toBe(true);
    // 下拉全冻结：卡片内 agent/responseMode/preset/defaultMode（显式 Listener 只读）
    const menus = r.root.findAllByType('details');
    expect(menus.length).toBeGreaterThan(0);
    for (const menu of menus) {
      expect(String(menu.props.className ?? '')).toContain('is-disabled');
      expect(menu.findByType('summary').props['aria-disabled']).toBe(true);
    }

    put.resolve(jsonRes(200, catalogBody('A', {
      revision: 'rev-A-2',
      profiles: [profileDto('A-profile', { label: 'edited' })],
    })));
    await flush();
    expect(labelInput(r, 0).props.disabled).toBe(false);
    expect(labelInput(r, 0).props.value).toBe('edited');
    expect(saveButton(r)!.props.disabled).toBe(true); // 保存后回到未 dirty
  });

  it('409 shows the conflict banner, disables save, and reload recovers', async () => {
    const fetchMock = stubFetchImmediate(
      { A: catalogBody('A') },
      () => jsonRes(409, { ok: false, error: 'config_conflict' }),
    );
    const r = await mount();
    await setInput(labelInput(r, 0), 'edited');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    const banner = r.root.findAllByProps({ className: 'hint-warn' })[0];
    expect(banner).toBeTruthy();
    expect(saveButton(r)!.props.disabled).toBe(true);

    // 冲突横幅里的「重新加载」→ 重新 GET，冲突清除
    const reload = banner.findByType('button');
    await act(async () => { reload.props.onClick(); });
    await flush();
    expect(fetchMock.mock.calls.filter(c => !(c[1] as RequestInit | undefined)?.method).length).toBe(2);
    expect(r.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
    expect(labelInput(r, 0).props.value).toBe(''); // 服务端版本，丢弃本地冲突稿
  });

  it('422 renders fieldErrors inline at the addressed input', async () => {
    stubFetchImmediate(
      { A: catalogBody('A') },
      () => jsonRes(422, {
        ok: false,
        error: 'validation_failed',
        fieldErrors: [{ path: 'profiles[0].id', message: 'id 与在会成员冲突' }],
      }),
    );
    const r = await mount();
    await setInput(labelInput(r, 0), 'edited');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    const errors = r.root.findAllByProps({ className: 'vc-profile-err' });
    expect(errors.some(node => textOf(node) === 'id 与在会成员冲突')).toBe(true);
    expect(saveButton(r)!.props.disabled).toBe(false); // 仍 dirty，可改后重试
  });
});

describe('VcConsumerProfilesGate · 私有端点挂载门', () => {
  it('canWrite=false never mounts the editor (zero fetch), shows the auth hint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(VcConsumerProfilesGate, {
        enabled: true, canWrite: false, listenerBotAppId: 'A', listenerBotOptions: TWO_BOTS,
      }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.root.findByProps({ className: 'hint' })).toBeTruthy();
    expect(r.root.findAllByProps({ className: 'vc-profiles-section' })).toHaveLength(0);
  });

  it('disabled feature renders nothing; canWrite=true mounts the editor', async () => {
    const fetchMock = stubFetchImmediate({ A: catalogBody('A') });
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(VcConsumerProfilesGate, {
        enabled: false, canWrite: true, listenerBotAppId: 'A', listenerBotOptions: TWO_BOTS,
      }));
    });
    expect(r.toJSON()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      r.update(React.createElement(VcConsumerProfilesGate, {
        enabled: true, canWrite: true, listenerBotAppId: 'A', listenerBotOptions: TWO_BOTS,
      }));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.root.findAllByProps({ className: 'vc-profiles-section' }).length).toBeGreaterThan(0);
  });
});
