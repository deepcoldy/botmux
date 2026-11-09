import React, { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OncallGroupSettings } from '../src/dashboard/web/bot-defaults-page.js';
import { DropdownField } from '../src/dashboard/web/field-controls.js';

let renderer: TestRenderer.ReactTestRenderer;
let fetcher: ReturnType<typeof vi.fn>;
let storedSecret: string;
let externallyUpdatePolicy: (policy: typeof initialPolicy) => void;
const response = (body: object, status = 200) => new Response(JSON.stringify({ ok: status === 200, ...body }), { status });
const initialPolicy = { enabled: true, chatIds: ['oc_demo'], flowMode: 'classify', formDisplay: 'thread_card', button: { timing: 'first', minTurns: 1 } };
const input = (name: string) => renderer.root.findByProps({ name });
const saveButton = () => renderer.root.findAllByType('button').find(button => button.props.className === 'primary')!;
const checkButton = () => renderer.root.findAllByType('button').find(button => button.props.children === '检测连接')!;
const writes = () => fetcher.mock.calls.filter(([, options]) => options?.method === 'PUT');
const change = (name: string, value: string) => act(() => input(name).props.onChange({ currentTarget: { value } }));
const toggle = () => act(() => renderer.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.onChange({ currentTarget: { checked: false }, target: { checked: false } }));
const save = async () => { await act(async () => { saveButton().props.onClick(); }); };

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => 'csrf-token' }) });
  storedSecret = 'current-service-secret';
  fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.startsWith('/api/oncall-connection')) return response({ endpoint: 'https://oncall.example.test/chat/', emailDomain: 'example.test' });
    if (url === '/api/oncall-service-secret') {
      if (options?.method === 'PUT') storedSecret = JSON.parse(options.body as string).secret;
      return response({ configured: true, secret: storedSecret });
    }
    if (url.endsWith('/oncall-group')) return response({ oncallGroup: JSON.parse(options!.body as string).oncallGroup });
    if (url.endsWith('/choices')) return response({ tenantId: JSON.parse(options!.body as string).tenantId, tenantName: '测试业务线', regions: [
      { value: 'regionA', label: '区域甲', categories: [{ value: '34', label: '付款问题' }] },
      { value: 'regionB', label: '区域乙', categories: [{ value: '56', label: '退款问题' }] },
    ] });
    if (url.endsWith('/check')) return response({});
    return response({ target: options?.body ? JSON.parse(options.body as string).target : { tenantId: 12 },
      tenantName: '测试业务线', connectionReady: true, credentialActive: true, connectionOk: true });
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { act(() => renderer?.unmount()); vi.unstubAllGlobals(); });
async function render(policy = initialPolicy) {
  function Host() {
    const [bot, setBot] = useState({ larkAppId: 'app', replyCardMode: 'unified', oncallGroup: policy });
    externallyUpdatePolicy = oncallGroup => setBot(previous => ({ ...previous, oncallGroup }));
    return React.createElement(OncallGroupSettings, { bot: bot as any, active: true,
      chats: [{ chatId: 'oc_demo', name: '支持群' }], patchBot: (_id, patch) => setBot(previous => ({ ...previous, ...patch } as typeof previous)) });
  }
  await act(async () => { renderer = TestRenderer.create(React.createElement(Host)); });
}

describe('Oncall unified save', () => {
  it('sends connection and credential changes in one write and can check them immediately', async () => {
    await render();
    change('oncallEndpoint', 'https://new.test/chat/');
    change('serviceSecret', 'new-service-secret');
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection']);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ endpoint: 'https://new.test/chat/', emailDomain: 'example.test', secret: 'new-service-secret' });
    expect(saveButton().props.disabled).toBe(true);
    expect(checkButton().props.disabled).toBe(false);
  });
  it('prefills collapsed advanced settings and writes only the edited connection on explicit save', async () => {
    await render();
    const advanced = renderer.root.findByProps({ className: 'bd-oncall-details bd-oncall-advanced' });
    expect(advanced.props.open).not.toBe(true);
    expect(input('oncallEndpoint').props.value).toBe('https://oncall.example.test/chat/');
    expect(input('oncallEmailDomain').props.value).toBe('example.test');
    change('oncallEndpoint', 'https://next.example.test/chat/');
    change('oncallEmailDomain', 'next.example.test');
    expect(writes()).toHaveLength(0);
    expect(checkButton().props.disabled).toBe(true);
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection']);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ endpoint: 'https://next.example.test/chat/', emailDomain: 'next.example.test' });
    expect(writes()[0][1].headers['x-botmux-csrf']).toBe('csrf-token');
    expect(saveButton().props.disabled).toBe(true);
    expect(checkButton().props.disabled).toBe(false);
  });
  it('can repair only the advanced connection when unavailable presets invalidate existing direct routing', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/choices')
      ? response({ error: 'connection unavailable' }, 503) : original(url, options));
    await render({ ...initialPolicy, flowMode: 'direct' });
    change('oncallEmailDomain', 'next.example.test');
    expect(saveButton().props.disabled).toBe(false);
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection']);
  });
  it('retains consecutive connection edits after the browser clears event targets', async () => {
    await render();
    act(() => {
      const endpointEvent: any = { currentTarget: { value: 'https://next.example.test/chat/' } };
      input('oncallEndpoint').props.onChange(endpointEvent);
      endpointEvent.currentTarget = null;
      const domainEvent: any = { currentTarget: { value: 'next.example.test' } };
      input('oncallEmailDomain').props.onChange(domainEvent);
      domainEvent.currentTarget = null;
    });
    expect(input('oncallEndpoint').props.value).toBe('https://next.example.test/chat/');
    expect(input('oncallEmailDomain').props.value).toBe('next.example.test');
    expect(writes()).toHaveLength(0);
  });
  it('prevents invalid connection values from being submitted', async () => {
    await render();
    for (const endpoint of ['http://insecure.test/chat/', 'https://user:password@example.test/chat/', 'https://example.test/chat/?token=secret']) {
      change('oncallEndpoint', endpoint);
      expect(saveButton().props.disabled).toBe(true);
    }
    change('oncallEndpoint', 'https://next.example.test/chat/'); change('oncallEmailDomain', '@example.test');
    expect(saveButton().props.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
  });
  it('retains connection drafts on failure and does not continue to policy writes', async () => {
    await render(); change('oncallEmailDomain', 'next.example.test'); toggle();
    fetcher.mockResolvedValueOnce(response({ error: 'connection failed' }, 503));
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection']);
    expect(input('oncallEmailDomain').props.value).toBe('next.example.test');
    expect(saveButton().props.disabled).toBe(false);
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection', '/api/oncall-connection', '/api/bots/app/oncall-group']);
  });
  it('does not repeat a saved connection when a later target write fails', async () => {
    await render(); change('oncallEmailDomain', 'next.example.test'); change('tenantId', '56');
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/oncall-target') && options?.method === 'PUT'
      ? response({ error: 'target failed' }, 503) : original(url, options));
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection', '/api/bots/app/oncall-target']);
    fetcher.mockImplementation(original); await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection', '/api/bots/app/oncall-target', '/api/bots/app/oncall-target']);
    expect(saveButton().props.disabled).toBe(true);
  });
  it('allows retrying the remaining enable policy after a connection becomes active', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/oncall-target')
      ? response({ target: { tenantId: 12 }, connectionReady: false, credentialActive: true }) : original(url, options));
    await render({ ...initialPolicy, enabled: false });
    change('oncallEmailDomain', 'next.example.test');
    act(() => renderer.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.onChange({ currentTarget: { checked: true }, target: { checked: true } }));
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/oncall-group')
      ? response({ error: 'policy failed' }, 503) : original(url, options));
    await save();
    expect(saveButton().props.disabled).toBe(false);
    fetcher.mockImplementation(original); await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-connection', '/api/bots/app/oncall-group', '/api/bots/app/oncall-group']);
    expect(saveButton().props.disabled).toBe(true);
  });
  it('disables advanced edits after permission failure while retaining normal business saves', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => url.startsWith('/api/oncall-connection')
      ? response({ error: 'forbidden' }, 403) : original(url, options));
    await render();
    const advanced = renderer.root.findByProps({ className: 'bd-oncall-details bd-oncall-advanced' });
    expect(advanced.findByType('fieldset').props.disabled).toBe(true);
    toggle(); await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/bots/app/oncall-group']);
  });

  it('saves the disabled forwarding mode and restores it after reload', async () => {
    await render();
    const forwarding = () => renderer.root.findAllByType(DropdownField).find(node => node.props.dataInput === 'oncallForwardMode')!;
    expect(forwarding().props.options.some((option: any) => option.value === 'none')).toBe(true);
    act(() => forwarding().props.onChange('none'));
    expect(writes()).toHaveLength(0);
    await save();
    const saved = JSON.parse(writes()[0][1].body).oncallGroup;
    expect(saved.forwardMode).toBe('none');
    act(() => renderer.unmount());
    await render(saved);
    expect(forwarding().props.value).toBe('none');
    expect(saveButton().props.disabled).toBe(true);
  });

  it('prefills the saved password and leaves it unchanged when saving business settings', async () => {
    await render();
    expect(renderer.root.findAllByType('button').filter(button => button.props.className === 'primary')).toHaveLength(1);
    expect(input('serviceSecret').props.value).toBe('current-service-secret');
    expect(input('serviceSecret').props.type).toBe('password');
    expect(saveButton().props.disabled).toBe(true);
    change('tenantId', '56'); toggle();
    expect(writes()).toHaveLength(0);
    expect(saveButton().props.disabled).toBe(false);
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/bots/app/oncall-target', '/api/bots/app/oncall-group']);
    expect(saveButton().props.disabled).toBe(true);
  });

  it('saves only a changed target and checks the saved version', async () => {
    await render(); change('tenantId', '56');
    expect(checkButton().props.disabled).toBe(true);
    await save();
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writes()[0][1].body)).toEqual({ target: { tenantId: 56 } });
    expect(checkButton().props.disabled).toBe(false);
    await act(async () => { checkButton().props.onClick(); });
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/bots/app/oncall-target/check');
  });

  it('saves new credentials before the target and policy, includes CSRF and preserves the password', async () => {
    await render(); change('tenantId', '56'); change('serviceSecret', 'new-service-secret'); toggle();
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-service-secret', '/api/bots/app/oncall-target', '/api/bots/app/oncall-group']);
    for (const [, options] of writes()) expect(options.headers['x-botmux-csrf']).toBe('csrf-token');
    expect(JSON.parse(writes()[0][1].body)).toEqual({ secret: 'new-service-secret' });
    expect(input('serviceSecret').props.value).toBe('new-service-secret');
    expect(saveButton().props.disabled).toBe(true);
  });

  it('loads the saved password after reload and does not resubmit unchanged credentials', async () => {
    await render();
    expect(input('serviceSecret').props.value).toBe(storedSecret);
    expect(input('serviceSecret').props.type).toBe('password');
    expect(saveButton().props.disabled).toBe(true);
    change('serviceSecret', 'updated-service-secret');
    await save();
    expect(input('serviceSecret').props.value).toBe('updated-service-secret');
    expect(saveButton().props.disabled).toBe(true);
    act(() => renderer.unmount());
    await render();
    expect(input('serviceSecret').props.value).toBe('updated-service-secret');
    expect(saveButton().props.disabled).toBe(true);
    toggle(); await save();
    expect(writes().filter(([url]) => url === '/api/oncall-service-secret')).toHaveLength(1);
  });
  it('can check a saved credential immediately after reload', async () => {
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => url === '/api/oncall-service-secret'
      ? response({ configured: true, secret: storedSecret, restartRequired: false }) : original(url, options));
    await render();
    expect(input('serviceSecret').props.value).toBe(storedSecret);
    expect(saveButton().props.disabled).toBe(true);
    expect(checkButton().props.disabled).toBe(false);
  });

  it('does not silently clear a required saved credential', async () => {
    await render(); change('serviceSecret', '');
    expect(saveButton().props.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
    change('serviceSecret', storedSecret);
    expect(saveButton().props.disabled).toBe(true);
    expect(checkButton().props.disabled).toBe(false);
  });
  it('stops after a credential failure and retains the unsaved fields for retry', async () => {
    await render(); change('tenantId', '56'); change('serviceSecret', 'new-service-secret'); toggle();
    fetcher.mockResolvedValueOnce(response({ error: 'secret failed' }, 503));
    await save();
    expect(writes()).toHaveLength(1);
    expect(input('serviceSecret').props.value).toBe('new-service-secret');
    expect(input('tenantId').props.value).toBe(56);
    expect(saveButton().props.disabled).toBe(false);
    await save();
    expect(writes()).toHaveLength(4);
    expect(saveButton().props.disabled).toBe(true);
  });

  it('retries only the remaining policy after the first two writes succeed', async () => {
    await render(); change('tenantId', '56'); change('serviceSecret', 'new-service-secret'); toggle();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => url.endsWith('/oncall-group')
      ? response({ error: 'policy failed' }, 503) : original(url, options));
    await save();
    expect(input('serviceSecret').props.value).toBe('new-service-secret');
    expect(saveButton().props.disabled).toBe(false);
    fetcher.mockImplementation(original);
    await save();
    expect(writes().map(([url]) => url)).toEqual(['/api/oncall-service-secret', '/api/bots/app/oncall-target', '/api/bots/app/oncall-group', '/api/bots/app/oncall-group']);
    expect(saveButton().props.disabled).toBe(true);
  });

  it('preserves a concurrent disable received while saving the target', async () => {
    await render(); change('tenantId', '56');
    const flow = renderer.root.findAllByType(DropdownField).find(node => node.props.dataInput === 'oncallForwardMode')!;
    act(() => flow.props.onChange('merge'));
    let release!: (value: Response) => void;
    fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    act(() => saveButton().props.onClick());
    act(() => externallyUpdatePolicy({ ...initialPolicy, enabled: false }));
    await act(async () => { release(response({ target: { tenantId: 56 }, connectionReady: true, credentialActive: true })); });
    expect(writes().map(([url]) => url)).toEqual(['/api/bots/app/oncall-target']);
    expect(renderer.root.findAllByType('input').find(node => node.props.type === 'checkbox')!.props.checked).toBe(false);
    expect(saveButton().props.disabled).toBe(true);
  });

  it('loads named preset selects below the mode and clears the category when its region changes', async () => {
    await render({ ...initialPolicy, flowMode: 'direct' });
    const field = (name: string) => renderer.root.findAllByType(DropdownField).find(node => node.props.dataInput === name)!;
    expect(renderer.root.findAllByProps({ name: 'region' })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ name: 'typeId' })).toHaveLength(0);
    expect(field('oncallPresetType').props.disabled).toBe(true);
    act(() => field('oncallPresetRegion').props.onChange('regionA'));
    expect(field('oncallPresetType').props.options.some((option: any) => option.label === '付款问题')).toBe(true);
    act(() => field('oncallPresetType').props.onChange('34'));
    expect(saveButton().props.disabled).toBe(false);
    act(() => field('oncallPresetRegion').props.onChange('regionB'));
    expect(field('oncallPresetType').props.value).toBe('');
    expect(saveButton().props.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
    act(() => field('oncallPresetType').props.onChange('56'));
    await save();
    expect(JSON.parse(writes()[0][1].body).target).toEqual({ tenantId: 12, region: 'regionB', typeId: 56 });
    await act(async () => field('oncallFlowMode').props.onChange('classify'));
    expect(renderer.root.findAllByType(DropdownField).some(node => node.props.dataInput === 'oncallPresetRegion')).toBe(false);
    expect(field('oncallFormDisplay')).toBeDefined();
  });

  it('clears preset routing when the business line changes', async () => {
    await render({ ...initialPolicy, flowMode: 'direct' });
    const field = (name: string) => renderer.root.findAllByType(DropdownField).find(node => node.props.dataInput === name)!;
    act(() => field('oncallPresetRegion').props.onChange('regionA'));
    act(() => field('oncallPresetType').props.onChange('34'));
    await act(async () => { input('tenantId').props.onChange({ currentTarget: { value: '24' } }); });
    expect(field('oncallPresetRegion').props.value).toBe('');
    expect(field('oncallPresetType').props.value).toBe('');
    expect(saveButton().props.disabled).toBe(true);
  });

  it('does not allow a failed target read to overwrite persisted routing', async () => {
    fetcher.mockImplementation(async (url: string) => url.endsWith('/oncall-target')
      ? response({ error: 'read failed' }, 503) : response({ configured: true }));
    await render();
    expect(saveButton().props.disabled).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});
