import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexProfilePicker } from '../src/dashboard/web/codex-profile-picker.js';
import { DropdownField } from '../src/dashboard/web/field-controls.js';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
const response = (appId: string, name: string) => ({ ok: true, json: async () => ({ larkAppId: appId, status: 'ok', candidates: [{ name, available: true }] }) });

describe('Codex profile picker request identity', () => {
  it('ignores a late response from another Bot and never silently changes a missing selection', async () => {
    const pending: Array<(value: unknown) => void> = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => pending.push(resolve))));
    const change = vi.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(CodexProfilePicker, { appId: 'a', contextKey: 'one', value: 'retained', onChange: change })); });
    await act(async () => renderer.update(React.createElement(CodexProfilePicker, { appId: 'b', contextKey: 'two', value: 'retained', onChange: change })));
    await act(async () => pending[1]!(response('b', 'second')));
    await act(async () => pending[0]!(response('a', 'first')));
    const field = renderer.root.findByType(DropdownField);
    expect(field.props.options.map((o: any) => o.value)).toEqual(['', 'retained', 'second']);
    expect(field.props.value).toBe('retained');
    expect(change).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: 'status' }).props.className).toContain('bd-aux-err');
    await act(async () => renderer.unmount());
  });
  it('refreshes, distinguishes errors from empty and leaves clear available', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true, json: async () => ({ larkAppId: 'a', status: 'empty', candidates: [] }) });
    vi.stubGlobal('fetch', fetcher);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(CodexProfilePicker, { appId: 'a', contextKey: 'one', value: 'missing', onChange: vi.fn() })); });
    expect(JSON.stringify(renderer.toJSON())).toContain('scan_failed');
    const refresh = renderer.root.findByProps({ 'data-action': 'refresh-codex-profiles' });
    await act(async () => refresh.props.onClick());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('scan_failed');
    expect(renderer.root.findByType(DropdownField).props.options[0]).toMatchObject({ value: '' });
    await act(async () => renderer.unmount());
  });
});
