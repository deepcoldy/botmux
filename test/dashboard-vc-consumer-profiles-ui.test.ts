import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  VcConsumerProfilesGate,
  VcConsumerProfilesSection,
} from '../src/dashboard/web/vc-consumer-profiles-section.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG } from '../src/services/vc-meeting-consumer-profile-templates.js';

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

/** 共享目录里的预设**不带执行方**——DTO 里根本没有 agentAppId 这个字段。 */
function profileDto(id: string, over: Json = {}): Json {
  return { id, responseMode: 'silent', permissionPreset: 'observe_only', ...over };
}

function agentOption(appId: string, over: Json = {}): Json {
  return {
    appId,
    label: appId,
    online: true,
    workingDirReady: true,
    reliableTurnTerminal: true,
    managedSideEffectEligible: true,
    sandboxIsolated: true,
    vcEnabled: true,
    vcEligible: true,
    textOutputPolicy: null,
    voiceOutputPolicy: null,
    realtimeVoiceEnabled: false,
    effectiveTextOutputPolicy: 'allow',
    effectiveVoiceOutputPolicy: 'deny',
    ...over,
  };
}

function catalogBody(over: Json = {}): Json {
  return {
    ok: true,
    revision: 'rev-1',
    catalogState: 'profiles',
    defaultMode: 'listenOnly',
    defaultConsumerIds: [],
    profiles: [profileDto('minutes', { label: '会议纪要' })],
    agentOptions: [agentOption('app_alpha', { label: 'Bot Alpha' })],
    templateCatalog: VC_MEETING_CONSUMER_PROFILE_TEMPLATE_CATALOG,
    ...over,
  };
}

const CONSUMER_PROFILES_URL = '/api/vc-meeting/consumer-profiles';
const PREFLIGHT_URL = '/api/vc-meeting/bot-preflight';

/** 路由式 fetch stub：GET 目录 / PUT 保存 / POST preflight 各自可注入。 */
function stubFetch(opts: {
  onGet?: (nth: number) => unknown;
  onPut?: (body: Json) => unknown;
  onPost?: (body: Json) => unknown;
} = {}): ReturnType<typeof vi.fn> {
  let gets = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Json : {};
    if (method === 'PUT') {
      return (opts.onPut ?? (() => jsonRes(200, catalogBody({ revision: 'rev-2' }))))(body);
    }
    if (method === 'POST') return (opts.onPost ?? (() => jsonRes(200, { ok: true })))(body);
    gets += 1;
    return (opts.onGet ?? (() => jsonRes(200, catalogBody())))(gets);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function mount(over: Json = {}): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      React.createElement(VcConsumerProfilesSection, { canWrite: true, ...over } as never),
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

/** 详情弹窗里固定两个文本框（id、label）。 */
function idInput(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return textInputs(r)[0];
}

function labelInput(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance {
  return textInputs(r)[1];
}

function profileCards(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return r.root.findAllByProps({ className: 'vc-profile-summary-card' });
}

async function openProfile(r: TestRenderer.ReactTestRenderer, index: number): Promise<void> {
  await act(async () => { profileCards(r)[index].props.onClick(); });
}

async function closeProfile(r: TestRenderer.ReactTestRenderer): Promise<void> {
  await act(async () => { buttonByClass(r, 'vc-profile-dialog-done')!.props.onClick(); });
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

function addButton(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance | undefined {
  return buttonByClass(r, 'vc-profile-add');
}

function setInput(input: TestRenderer.ReactTestInstance, value: string): Promise<void> {
  return act(async () => { input.props.onChange({ target: { value }, currentTarget: { value } }); });
}

/** 「设为默认」单选框：定位到卡片文本含 label 的那张卡。 */
function defaultRadio(
  r: TestRenderer.ReactTestRenderer, label: string,
): TestRenderer.ReactTestInstance | undefined {
  const card = profileCards(r).find(node => textOf(node).includes(label));
  return card?.findAllByType('input').find(input => input.props.type === 'radio');
}

/** 点单选框：未选中走 onChange，已选中走 onClick（浏览器不会为同值再发 change）。 */
async function clickDefaultRadio(
  r: TestRenderer.ReactTestRenderer, label: string,
): Promise<void> {
  const radio = defaultRadio(r, label)!;
  const wasChecked = radio.props.checked === true;
  await act(async () => {
    if (wasChecked) radio.props.onClick();
    else radio.props.onChange({ currentTarget: { checked: true }, target: { checked: true } });
  });
}

function botRows(r: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return r.root.findAllByProps({ className: 'vc-bot-policy-row' });
}

function botRow(
  r: TestRenderer.ReactTestRenderer, label: string,
): TestRenderer.ReactTestInstance {
  const row = botRows(r).find(node => textOf(node).includes(label));
  if (!row) throw new Error(`bot policy row not found: ${label}`);
  return row;
}

function rowCheckbox(
  row: TestRenderer.ReactTestInstance, which: 'vcEnabled' | 'realtimeVoice',
): TestRenderer.ReactTestInstance {
  const boxes = row.findAllByType('input').filter(input => input.props.type === 'checkbox');
  return which === 'vcEnabled' ? boxes[0] : boxes[1];
}

function rowSelect(
  row: TestRenderer.ReactTestInstance, which: 'defaultProfile' | 'text' | 'voice',
): TestRenderer.ReactTestInstance {
  // 每行的 select 顺序：默认角色 → 文字 → 语音。
  const selects = row.findAllByType('select');
  const index = which === 'defaultProfile' ? 0 : which === 'text' ? 1 : 2;
  return selects[index]!;
}

function preflightButton(row: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  return row.findAllByType('button')
    .find(button => String(button.props.className ?? '').split(' ').includes('vc-bot-policy-preflight-btn'))!;
}

function callsByMethod(
  fetchMock: ReturnType<typeof vi.fn>, method: string,
): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return (init?.method ?? 'GET') === method;
  }) as Array<[string, RequestInit | undefined]>;
}

function putCalls(fetchMock: ReturnType<typeof vi.fn>): Json[] {
  return callsByMethod(fetchMock, 'PUT').map(call => JSON.parse(String(call[1]!.body)) as Json);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VcConsumerProfilesSection · 共享目录（不再按 bot 配置）', () => {
  it('loads one fleet-wide catalog with no listener selector and no per-bot configuring target', async () => {
    const fetchMock = stubFetch();
    const r = await mount();

    // 只有一个无参 GET：目录不再按 bot 分片，也就没有「配置所属 Listener」这一说。
    expect(callsByMethod(fetchMock, 'GET')).toHaveLength(1);
    expect(fetchMock.mock.calls[0][0]).toBe(CONSUMER_PROFILES_URL);

    const section = r.root.findByProps({ className: 'vc-profiles-section' });
    expect(textOf(section)).toContain('这份预设由所有 bot 共享');
    expect(textOf(section)).not.toContain('正在配置');
    expect(r.root.findAllByProps({ className: 'vc-profile-config-target' })).toHaveLength(0);
    expect(r.root.findAllByProps({ 'aria-label': '配置所属 Listener' })).toHaveLength(0);
    expect(r.root.findAllByProps({ 'aria-label': '会议事件接收 Bot' })).toHaveLength(0);
  });

  it('never writes an execution bot into a saved profile', async () => {
    // 回归：预设过去把执行方 agentAppId 焊死在条目里，播种兜底还会写进**另一个**
    // bot 的 appId——「拉 A 进会却把 B 拉进监听群」。现在 DTO 里没有这个字段，
    // 执行方在读路径绑定为收到会议事件的那个 bot 自己。
    const fetchMock = stubFetch();
    const r = await mount();
    await clickDefaultRadio(r, '会议纪要');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    const put = putCalls(fetchMock)[0];
    expect(put).toMatchObject({
      expectedRevision: 'rev-1',
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
    });
    const profiles = put.profiles as Json[];
    expect(profiles).toHaveLength(1);
    expect(Object.keys(profiles[0])).not.toContain('agentAppId');
    expect(JSON.stringify(put)).not.toContain('agentAppId');
  });
});

describe('VcConsumerProfilesSection · 加载', () => {
  it('renders no editor (and no save button) while a load is pending', async () => {
    const pending = defer();
    stubFetch({ onGet: () => pending.promise });
    const r = await mount();
    expect(saveButton(r)).toBeUndefined();
    expect(textInputs(r)).toHaveLength(0);
    expect(botRows(r)).toHaveLength(0);
    pending.resolve(jsonRes(200, catalogBody()));
    await flush();
    expect(saveButton(r)).toBeTruthy();
  });

  it('surfaces a load failure and mounts no editor', async () => {
    stubFetch({ onGet: () => jsonRes(503, { ok: false, error: 'config_unavailable' }) });
    const r = await mount();
    expect(r.root.findAllByProps({ className: 'hint-warn' })
      .some(node => textOf(node).includes('config_unavailable'))).toBe(true);
    expect(saveButton(r)).toBeUndefined();
  });

  it('discards a superseded load response when the reload button is double-clicked', async () => {
    // 目录没有 bot 选择器后，唯一能并发触发两次 load 的入口是冲突横幅的「重新加载」。
    // 慢的那次响应回来时 token 已过期，绝不能覆盖新响应（也不能污染保存目标）。
    const reloads: Deferred[] = [];
    const fetchMock = stubFetch({
      onGet: (nth) => {
        if (nth === 1) return jsonRes(200, catalogBody());
        const d = defer();
        reloads.push(d);
        return d.promise;
      },
      onPut: () => jsonRes(409, { ok: false, error: 'config_conflict' }),
    });
    const r = await mount();
    await openProfile(r, 0);
    await setInput(labelInput(r), 'edited');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    const reload = r.root.findAllByProps({ className: 'hint-warn' })[0].findByType('button');
    await act(async () => { reload.props.onClick(); reload.props.onClick(); });
    expect(reloads).toHaveLength(2);

    reloads[1].resolve(jsonRes(200, catalogBody({
      revision: 'rev-fresh', profiles: [profileDto('fresh', { label: '最新目录' })],
    })));
    await flush();
    reloads[0].resolve(jsonRes(200, catalogBody({
      revision: 'rev-stale', profiles: [profileDto('stale', { label: '过期目录' })],
    })));
    await flush();

    expect(textOf(r.root.findByProps({ className: 'vc-profile-card-grid' }))).toContain('最新目录');
    expect(textOf(r.root.findByProps({ className: 'vc-profile-card-grid' }))).not.toContain('过期目录');
    await clickDefaultRadio(r, '最新目录');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock).at(-1)?.expectedRevision).toBe('rev-fresh');
  });
});

describe('VcConsumerProfilesSection · 预设编辑', () => {
  it('shows the built-in library and copies templates into detached editable profiles', async () => {
    const fetchMock = stubFetch();
    const r = await mount();

    expect(r.root.findAllByProps({ className: 'vc-profile-template-card' })).toHaveLength(5);
    expect(textOf(r.root)).toContain('会议纪要与行动项');
    expect(textOf(r.root)).toContain('会议主持');
    expect(textOf(r.root)).toContain('方案评审与风险挑战');
    expect(textOf(r.root)).toContain('访谈与需求洞察');
    const useFirstTemplate = async () => {
      await act(async () => {
        r.root.findAllByProps({ className: 'vc-profile-template-card' })[0].props.onClick();
      });
      await act(async () => { buttonByClass(r, 'vc-profile-template-use')!.props.onClick(); });
    };
    await useFirstTemplate();
    expect(idInput(r).props.value).toBe('important-sync');
    expect(labelInput(r).props.value).toBe('会议重要信息同步');
    expect(r.root.findByType('textarea').props.value).toContain('时间、负责人、范围、状态或结论的修正');
    await closeProfile(r);
    // 第二次用同一个模板：id 自动去重，不会撞上刚建的那条。
    await useFirstTemplate();
    expect(idInput(r).props.value).toBe('important-sync-2');

    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    const created = (putCalls(fetchMock)[0].profiles as Json[])[1];
    expect(created).toMatchObject({
      id: 'important-sync',
      responseMode: 'listener_thread',
      listenerPlacement: 'topic',
      permissionPreset: 'observe_only',
      activityTypes: ['transcript_received', 'chat_received'],
    });
    expect(Object.keys(created)).not.toContain('agentAppId');
  });

  it('keeps the default role single-select and clears it when the selected one is clicked again', async () => {
    const fetchMock = stubFetch({
      onGet: () => jsonRes(200, catalogBody({
        profiles: [profileDto('minutes', { label: '会议纪要' }), profileDto('scribe', { label: '速记' })],
      })),
    });
    const r = await mount();

    await clickDefaultRadio(r, '会议纪要');
    expect(defaultRadio(r, '会议纪要')!.props.checked).toBe(true);
    expect(defaultRadio(r, '速记')!.props.checked).toBe(false);

    // 换一个：单选，前一个自动取消——一个 bot 进会只跑一个角色。
    await clickDefaultRadio(r, '速记');
    expect(defaultRadio(r, '会议纪要')!.props.checked).toBe(false);
    expect(defaultRadio(r, '速记')!.props.checked).toBe(true);

    // 再点一次已选中的：回到仅监听。
    await clickDefaultRadio(r, '速记');
    expect(defaultRadio(r, '速记')!.props.checked).toBe(false);
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock)[0]).toMatchObject({ defaultMode: 'listenOnly', defaultConsumerIds: [] });
  });

  it('follows an id rename into defaultConsumerIds and falls back to listen-only when the default is removed', async () => {
    const fetchMock = stubFetch();
    const r = await mount();

    await act(async () => { addButton(r)!.props.onClick(); });
    await setInput(idInput(r), 'draft');
    await clickDefaultRadio(r, 'draft');
    await setInput(idInput(r), 'draft-renamed');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock)[0]).toMatchObject({
      defaultMode: 'agents',
      defaultConsumerIds: ['draft-renamed'],
    });
    expect((putCalls(fetchMock)[0].profiles as Json[]).map(p => p.id)).toEqual(['minutes', 'draft-renamed']);

    // 删掉那条默认角色：ids 空了就必须退回 listenOnly，否则 agents + 空 ids 会在
    // 保存时被服务端拒绝，用户要到 422 才知道。
    await act(async () => { addButton(r)!.props.onClick(); });
    await setInput(idInput(r), 'temp');
    await clickDefaultRadio(r, 'temp');
    await act(async () => { buttonByClass(r, 'vc-profile-remove')!.props.onClick(); });
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock).at(-1)).toMatchObject({ defaultMode: 'listenOnly', defaultConsumerIds: [] });

    // 把默认角色的 id 清空同理：清空那一刻默认角色就没了，后面再补一个新 id 也不会
    // 自动跟回来（ids 已空），此时若还留着 agents 就是同一个必吃 422 的组合。
    await act(async () => { addButton(r)!.props.onClick(); });
    await setInput(idInput(r), 'blanked');
    await clickDefaultRadio(r, 'blanked');
    await setInput(idInput(r), '');
    await setInput(idInput(r), 'typed-again');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock).at(-1)).toMatchObject({ defaultMode: 'listenOnly', defaultConsumerIds: [] });
  });
});

describe('VcConsumerProfilesSection · 按 bot 的会议开关', () => {
  const THREE_BOTS = [
    agentOption('app_off', { label: 'Bot Beta', vcEnabled: false }),
    agentOption('app_api', {
      label: 'Bot Gamma', vcEligible: false, vcEnabled: false, workingDirReady: false,
    }),
    agentOption('app_on', { label: 'Bot Alpha' }),
  ];

  it('lists every bot, enabled first, and disables what an apiOnly bot cannot use', async () => {
    stubFetch({ onGet: () => jsonRes(200, catalogBody({ agentOptions: THREE_BOTS })) });
    const r = await mount();

    expect(botRows(r)).toHaveLength(3);
    // 接收会议事件的排前面，其余按名字——整个 fleet 都在表里，不用先去别处开开关。
    expect(botRows(r).findIndex(row => textOf(row).includes('Bot Alpha'))).toBe(0);

    const gamma = botRow(r, 'Bot Gamma');
    // 能力缺口收成一个 ⚠，详情走 InfoTip（hover 可靠 tooltip，非原生 title——
    // 原生 title 在小元素上常触发不了）。文案在 tip 的 label（aria + 可读）里。
    // InfoTip 根 span 的 className 是 `ui-info-tip vc-bot-policy-warn-tip`（拼接），
    // 按子串匹配再读 label。
    const gammaWarnTip = gamma.findAll(node =>
      typeof node.props.className === 'string'
      && node.props.className.includes('vc-bot-policy-warn-tip'))[0];
    expect(gammaWarnTip?.props.label).toContain('无飞书连接（apiOnly），收不到会议事件');
    expect(rowCheckbox(gamma, 'vcEnabled').props.disabled).toBe(true);
    expect(preflightButton(gamma).props.disabled).toBe(true);

    // 关掉「接收会议事件」的 bot：会中输出策略无从谈起，一并禁用。
    const beta = botRow(r, 'Bot Beta');
    expect(rowSelect(beta, 'text').props.disabled).toBe(true);
    expect(rowCheckbox(beta, 'realtimeVoice').props.disabled).toBe(true);
    expect(textOf(beta)).toContain('不接收会议事件');

    const alpha = botRow(r, 'Bot Alpha');
    expect(rowSelect(alpha, 'text').props.disabled).toBe(false);
    expect(preflightButton(alpha).props.disabled).toBe(false);
  });

  it('filters the bot rows by the search box (name or appId)', async () => {
    stubFetch({ onGet: () => jsonRes(200, catalogBody({ agentOptions: THREE_BOTS })) });
    const r = await mount();
    expect(botRows(r)).toHaveLength(3);

    const search = r.root.findAllByType('input').find(i => i.props.className === 'vc-bot-policy-search')!;
    await setInput(search, 'Gamma');
    expect(botRows(r)).toHaveLength(1);
    expect(textOf(botRows(r)[0]!)).toContain('Bot Gamma');

    // 按 appId 也能命中。
    await setInput(search, 'app_on');
    expect(botRows(r)).toHaveLength(1);
    expect(textOf(botRows(r)[0]!)).toContain('Bot Alpha');

    // 无命中给空态提示。
    await setInput(search, 'zzz-nope');
    expect(botRows(r)).toHaveLength(0);

    // 清空恢复全部。
    await setInput(search, '');
    expect(botRows(r)).toHaveLength(3);
  });

  it('submits only the bot rows whose policy actually changed', async () => {
    const fetchMock = stubFetch({ onGet: () => jsonRes(200, catalogBody({ agentOptions: THREE_BOTS })) });
    const r = await mount();

    const alpha = botRow(r, 'Bot Alpha');
    await act(async () => {
      rowSelect(alpha, 'text').props.onChange({ target: { value: 'approval' } });
    });
    await act(async () => {
      rowCheckbox(botRow(r, 'Bot Alpha'), 'realtimeVoice').props.onChange({ target: { checked: true } });
    });
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    expect(putCalls(fetchMock)[0].botOutputPolicies).toEqual([{
      appId: 'app_on',
      vcEnabled: true,
      textOutputPolicy: 'approval',
      voiceOutputPolicy: null,
      realtimeVoiceEnabled: true,
      catalogDefaultConsumerId: null,
    }]);
  });

  it('submits a per-bot default role picked from the shared catalog', async () => {
    const fetchMock = stubFetch({ onGet: () => jsonRes(200, catalogBody({ agentOptions: THREE_BOTS })) });
    const r = await mount();

    await act(async () => {
      rowSelect(botRow(r, 'Bot Alpha'), 'defaultProfile').props.onChange({ target: { value: 'minutes' } });
    });
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    expect(putCalls(fetchMock)[0].botOutputPolicies).toEqual([{
      appId: 'app_on',
      vcEnabled: true,
      textOutputPolicy: null,
      voiceOutputPolicy: null,
      realtimeVoiceEnabled: false,
      catalogDefaultConsumerId: 'minutes',
    }]);
  });

  it('drops a row from the patch when it is edited back to its loaded value', async () => {
    const fetchMock = stubFetch({ onGet: () => jsonRes(200, catalogBody({ agentOptions: THREE_BOTS })) });
    const r = await mount();

    await act(async () => {
      rowSelect(botRow(r, 'Bot Alpha'), 'voice').props.onChange({ target: { value: 'deny' } });
    });
    await act(async () => {
      rowSelect(botRow(r, 'Bot Alpha'), 'voice').props.onChange({ target: { value: 'default' } });
    });
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();
    expect(putCalls(fetchMock)[0].botOutputPolicies).toEqual([]);
  });

  it('freezes every edit control while a save is pending, unfreezes on success', async () => {
    const put = defer();
    stubFetch({
      onGet: () => jsonRes(200, catalogBody({ agentOptions: THREE_BOTS })),
      onPut: () => put.promise,
    });
    const r = await mount();
    await openProfile(r, 0);
    await setInput(labelInput(r), 'edited');

    await act(async () => { saveButton(r)!.props.onClick(); });
    for (const input of r.root.findAllByType('input')) {
      expect(input.props.disabled).toBe(true);
    }
    for (const select of r.root.findAllByType('select')) {
      expect(select.props.disabled).toBe(true);
    }
    expect(r.root.findByType('textarea').props.disabled).toBe(true);
    expect(addButton(r)!.props.disabled).toBe(true);
    expect(buttonByClass(r, 'vc-profile-remove')!.props.disabled).toBe(true);
    expect(saveButton(r)!.props.disabled).toBe(true);
    const menus = r.root.findAllByType('details');
    expect(menus.length).toBeGreaterThan(0);
    for (const menu of menus) {
      expect(String(menu.props.className ?? '')).toContain('is-disabled');
      expect(menu.findByType('summary').props['aria-disabled']).toBe(true);
    }

    put.resolve(jsonRes(200, catalogBody({
      revision: 'rev-2',
      agentOptions: THREE_BOTS,
      profiles: [profileDto('minutes', { label: 'edited' })],
    })));
    await flush();
    await openProfile(r, 0);
    expect(labelInput(r).props.disabled).toBe(false);
    expect(labelInput(r).props.value).toBe('edited');
    expect(saveButton(r)!.props.disabled).toBe(true); // 保存后回到未 dirty
  });
});

describe('VcConsumerProfilesSection · 配置权限（preflight）', () => {
  const TWO_BOTS = [
    agentOption('app_on', { label: 'Bot Alpha' }),
    agentOption('app_two', { label: 'Bot Delta' }),
  ];

  it('posts the bot appId, blocks a concurrent run, and keeps unsaved policy edits', async () => {
    const pending = defer();
    const posted: Json[] = [];
    const fetchMock = stubFetch({
      onGet: () => jsonRes(200, catalogBody({ agentOptions: TWO_BOTS })),
      onPost: (body) => { posted.push(body); return pending.promise; },
    });
    const qr = vi.fn();
    const r = await mount({ onFeishuLoginQr: qr });

    // 先做一处没保存的策略编辑：preflight 成功后刻意不 reload，否则会冲掉它。
    await act(async () => {
      rowSelect(botRow(r, 'Bot Alpha'), 'text').props.onChange({ target: { value: 'deny' } });
    });

    await act(async () => { preflightButton(botRow(r, 'Bot Alpha')).props.onClick(); });
    expect(posted).toEqual([{ appId: 'app_on' }]);
    expect(callsByMethod(fetchMock, 'POST')[0][0]).toBe(PREFLIGHT_URL);
    // 开放平台会话是共享的，一次只允许跑一个：所有行的按钮都禁掉。
    expect(preflightButton(botRow(r, 'Bot Alpha')).props.disabled).toBe(true);
    expect(preflightButton(botRow(r, 'Bot Delta')).props.disabled).toBe(true);
    expect(textOf(botRow(r, 'Bot Alpha'))).toContain('配置中…');

    pending.resolve(jsonRes(200, { ok: true }));
    await flush();
    expect(textOf(botRow(r, 'Bot Alpha'))).toContain('权限与事件订阅已就绪');
    expect(qr).toHaveBeenCalledWith(null);
    expect(callsByMethod(fetchMock, 'GET')).toHaveLength(1); // 没有 reload
    expect(rowSelect(botRow(r, 'Bot Alpha'), 'text').props.value).toBe('deny');
    expect(saveButton(r)!.props.disabled).toBe(false); // 未保存的编辑还在
    expect(preflightButton(botRow(r, 'Bot Delta')).props.disabled).toBe(false);
  });

  it('surfaces the login QR and the error text when preflight fails', async () => {
    stubFetch({
      onGet: () => jsonRes(200, catalogBody({ agentOptions: TWO_BOTS })),
      onPost: () => jsonRes(200, {
        ok: false, error: 'feishu_login_required', feishuLoginQr: 'data:image/png;base64,QR',
      }),
    });
    const qr = vi.fn();
    const r = await mount({ onFeishuLoginQr: qr });

    await act(async () => { preflightButton(botRow(r, 'Bot Alpha')).props.onClick(); });
    await flush();
    expect(qr).toHaveBeenCalledWith('data:image/png;base64,QR');
    const failure = botRow(r, 'Bot Alpha').findAllByProps({ className: 'vc-bot-policy-warn' });
    expect(failure.some(node => textOf(node) === 'feishu_login_required')).toBe(true);
    expect(preflightButton(botRow(r, 'Bot Alpha')).props.disabled).toBe(false); // 可重试
  });
});

describe('VcConsumerProfilesSection · 保存失败', () => {
  it('409 shows the conflict banner, disables save, and reload recovers', async () => {
    const fetchMock = stubFetch({ onPut: () => jsonRes(409, { ok: false, error: 'config_conflict' }) });
    const r = await mount();
    await openProfile(r, 0);
    await setInput(labelInput(r), 'edited');
    await act(async () => { saveButton(r)!.props.onClick(); });
    await flush();

    const banner = r.root.findAllByProps({ className: 'hint-warn' })[0];
    expect(banner).toBeTruthy();
    expect(saveButton(r)!.props.disabled).toBe(true);

    const reload = banner.findByType('button');
    await act(async () => { reload.props.onClick(); });
    await flush();
    expect(callsByMethod(fetchMock, 'GET')).toHaveLength(2);
    expect(r.root.findAllByProps({ className: 'hint-warn' })).toHaveLength(0);
    await openProfile(r, 0);
    expect(labelInput(r).props.value).toBe('会议纪要'); // 服务端版本，丢弃本地冲突稿
  });

  it('422 renders fieldErrors inline at the addressed input', async () => {
    stubFetch({
      onPut: () => jsonRes(422, {
        ok: false,
        error: 'validation_failed',
        fieldErrors: [{ path: 'profiles[0].id', message: 'id 与在会成员冲突' }],
      }),
    });
    const r = await mount();
    await openProfile(r, 0);
    await setInput(labelInput(r), 'edited');
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
        enabled: true, canWrite: false,
      }));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.root.findByProps({ className: 'hint' })).toBeTruthy();
    expect(r.root.findAllByProps({ className: 'vc-profiles-section' })).toHaveLength(0);
  });

  it('disabled feature renders nothing; canWrite=true mounts the editor', async () => {
    const fetchMock = stubFetch();
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(React.createElement(VcConsumerProfilesGate, {
        enabled: false, canWrite: true,
      }));
    });
    expect(r.toJSON()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      r.update(React.createElement(VcConsumerProfilesGate, { enabled: true, canWrite: true }));
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.root.findAllByProps({ className: 'vc-profiles-section' }).length).toBeGreaterThan(0);
  });
});

describe('会议角色预设 · 文案', () => {
  it('retires the per-bot listener wording and states the shared contract in both locales', () => {
    const zh = createDashboardTranslator('zh');
    const en = createDashboardTranslator('en');

    // 退役的按-bot 措辞：翻译缺失时 translator 原样回 key。
    expect(zh('settings.vcMeetingListenerBot')).toBe('settings.vcMeetingListenerBot');
    expect(en('settings.vcMeetingListenerBot')).toBe('settings.vcMeetingListenerBot');
    expect(zh('settings.vcProfiles.fieldAgent')).toBe('settings.vcProfiles.fieldAgent');

    expect(zh('settings.vcProfiles.sharedNotice')).toContain('谁被拉进会议，就由谁执行');
    expect(en('settings.vcProfiles.sharedNotice')).toContain('shared by every bot');
    expect(zh('settings.vcProfiles.defaultSingleHint')).toContain('默认角色只能有一个');
    expect(en('settings.vcProfiles.defaultSingleHint')).toContain('Only one default role');
    expect(zh('settings.vcProfiles.botPolicies.title')).toBe('按 Bot 的会议开关');
    expect(en('settings.vcProfiles.botPolicies.title')).toBe('Per-bot meeting switches');
    expect(zh('settings.vcProfiles.botPolicies.vcIneligible')).toContain('apiOnly');
    expect(en('settings.vcProfiles.botPolicies.vcIneligible')).toContain('apiOnly');
    expect(zh('settings.vcProfiles.botPolicies.preflightHelp')).toContain('订阅会议事件');
    expect(zh('settings.vcProfiles.botPolicies.preflightHelp')).toContain('启动时自动体检');
    expect(en('settings.vcProfiles.botPolicies.preflightHelp')).toContain('subscribe meeting events');
    expect(en('settings.vcProfiles.botPolicies.preflightHelp')).toContain('auto-checked at daemon startup');
  });
});
