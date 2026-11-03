import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackStoragePanel } from '../src/dashboard/web/feedback-storage-panel.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
describe('feedback storage panel', () => {
  it('offers PostgreSQL and saves a candidate without sending a blank password', async () => {
    const writes: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') writes.push(JSON.parse(String(options.body)));
      return { ok: true, status: 200, json: async () => ({ generation: 1, active: { backend: 'sqlite' }, migrations: [] }) };
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(FeedbackStoragePanel)); });
    const select = renderer.root.findByProps({ id: 'feedback-storage-backend' });
    expect(select.findAllByType('option').map(option => option.props.value)).toContain('postgresql');
    await act(async () => { select.props.onChange({ target: { value: 'postgresql' } }); });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-save' }).props.onClick(); });
    expect(writes[0].candidate.backend).toBe('postgresql');
    expect(writes[0]).not.toHaveProperty('password');
    await act(async () => renderer.unmount());
  });
});
