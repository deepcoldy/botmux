import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupMessageRecall } from '../src/dashboard/web/group-message-recall.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { confirm } from '../src/dashboard/web/confirm-modal.js';
import type { GroupRecallMessage } from '../src/services/group-message-recall.js';
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: vi.fn(async () => true) }));
vi.mock('../src/dashboard/web/react-hooks.js', async () => {
  const { createDashboardTranslator } = await import('../src/dashboard/web/i18n.js');
  const tr = createDashboardTranslator('en');
  return { useT: () => tr };
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const tr = createDashboardTranslator('en');
const props = { chatId: 'oc_group', bots: [{ larkAppId: 'cli_bot', botName: 'Bot' }], active: true };
const message = (id: string, canRecall = true): GroupRecallMessage => ({ messageId: id, senderName: 'Bot', msgType: 'text', createTime: '1000', preview: id, canRecall, deleted: false, hasThread: false });
const response = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
let renderer: TestRenderer.ReactTestRenderer;
let fetchMock: ReturnType<typeof vi.fn>;
async function render(extra = {}) { await act(async () => { renderer = TestRenderer.create(React.createElement(GroupMessageRecall, { ...props, ...extra })); }); }
async function select(id: string) { await act(async () => renderer.root.findByProps({ 'aria-label': tr('groups.recallSelectMessage', { id }) }).props.onChange({ currentTarget: { checked: true } })); }
function recallButton() { return renderer.root.findAllByType('button').find(node => node.children.join('').startsWith('Recall selected'))!; }
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(confirm).mockResolvedValue(true);
  fetchMock = vi.fn(async () => response({ ok: true, messages: [message('om_good'), message('om_failed'), message('om_foreign', false)], hasMore: false }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { if (renderer) act(() => renderer.unmount()); vi.unstubAllGlobals(); });

describe('group recall UI', () => {
  it('loads only in the active tab and leaves other senders unselectable', async () => {
    await render({ active: false }); expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => renderer.update(React.createElement(GroupMessageRecall, props)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(renderer.root.findByProps({ 'aria-label': tr('groups.recallSelectMessage', { id: 'om_foreign' }) }).props.disabled).toBe(true);
  });
  it('confirms exact selected ids, keeps partial failures selected and allows retry', async () => {
    await render(); await select('om_good'); await select('om_failed');
    fetchMock.mockResolvedValueOnce(response({ ok: false, results: [{ messageId: 'om_good', ok: true }, { messageId: 'om_failed', ok: false, error: 'expired' }] }));
    await act(async () => recallButton().props.onClick());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ messageIds: ['om_good', 'om_failed'] });
    expect(renderer.root.findByProps({ 'aria-label': tr('groups.recallSelectMessage', { id: 'om_good' }) }).props.disabled).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': tr('groups.recallSelectMessage', { id: 'om_failed' }) }).props.checked).toBe(true);
    expect(renderer.root.findByProps({ role: 'status' }).findByType('strong').children.join('')).toBe(tr('groups.recallSummary', { ok: 1, failed: 1 }));
  });
  it('does not submit a selection if the drawer context closes while confirmation is pending', async () => {
    let resolve!: (value: boolean) => void;
    vi.mocked(confirm).mockReturnValue(new Promise<boolean>(done => { resolve = done; }));
    await render(); await select('om_good');
    await act(async () => recallButton().props.onClick());
    await act(async () => renderer.update(React.createElement(GroupMessageRecall, { ...props, active: false })));
    await act(async () => resolve(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('caps select-all at 50 and permits clearing the selection after loading more messages', async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: true, messages: Array.from({ length: 55 }, (_, i) => message(`om_${i}`)), hasMore: false }));
    await render();
    const all = () => renderer.root.findByProps({ 'aria-label': tr('groups.recallSelectAll') });
    await act(async () => all().props.onChange({ currentTarget: { checked: true } }));
    expect(all().props.checked).toBe(true);
    expect(renderer.root.findByProps({ 'aria-label': tr('groups.recallSelectMessage', { id: 'om_54' }) }).props.disabled).toBe(true);
    await act(async () => recallButton().props.onClick());
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).messageIds).toHaveLength(50);
    await act(async () => all().props.onChange({ currentTarget: { checked: false } }));
    expect(recallButton().props.disabled).toBe(true);
  });
  it('encodes pagination tokens and opens topic replies without carrying the old selection', async () => {
    fetchMock.mockResolvedValueOnce(response({ ok: true, messages: [{ ...message('om_root'), hasThread: true }], hasMore: true, pageToken: 'next+/=' }));
    await render(); await select('om_root');
    const byText = (text: string) => renderer.root.findAllByType('button').find(node => node.children.join('') === text)!;
    await act(async () => byText(tr('groups.recallMore')).props.onClick());
    expect(fetchMock.mock.calls[1][0]).toContain('pageToken=next%2B%2F%3D');
    await act(async () => byText(tr('groups.recallThread')).props.onClick());
    expect(fetchMock.mock.calls[2][0]).toContain('threadRootId=om_root');
    expect(recallButton().props.disabled).toBe(true);
  });
  it('refreshes after a pending recall finishes across tab switches', async () => {
    let resolve!: (value: any) => void;
    await render(); await select('om_good');
    fetchMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await act(async () => recallButton().props.onClick());
    await act(async () => renderer.update(React.createElement(GroupMessageRecall, { ...props, active: false })));
    await act(async () => renderer.update(React.createElement(GroupMessageRecall, props)));
    fetchMock.mockResolvedValueOnce(response({ ok: true, messages: [{ ...message('om_good', false), deleted: true }], hasMore: false }));
    await act(async () => resolve(response({ ok: true, results: [{ messageId: 'om_good', ok: true }] })));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const checkbox = renderer.root.findByProps({ 'aria-label': tr('groups.recallSelectMessage', { id: 'om_good' }) });
    expect(checkbox.props.checked).toBe(false);
    expect(checkbox.props.disabled).toBe(true);
  });
  it('ignores an obsolete list response after changing chat context', async () => {
    let resolve!: (value: any) => void;
    fetchMock.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await render({ bots: [...props.bots, { larkAppId: 'cli_other', botName: 'Other' }] });
    // A new route/context invalidates the earlier request even if a transport ignores AbortSignal.
    await act(async () => renderer.update(React.createElement(GroupMessageRecall, { ...props, chatId: 'oc_other' })));
    await act(async () => resolve(response({ ok: true, messages: [message('om_stale')], hasMore: false })));
    expect(renderer.root.findAllByProps({ 'aria-label': tr('groups.recallSelectMessage', { id: 'om_stale' }) })).toHaveLength(0);
  });
});
