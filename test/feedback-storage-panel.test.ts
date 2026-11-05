import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeedbackStoragePanel } from '../src/dashboard/web/feedback-storage-panel.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());
describe('feedback storage panel', () => {
  it('saves structured doas identity instead of sending a token value', async () => {
    const writes: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') writes.push(JSON.parse(String(options.body)));
      return { ok: true, status: 200, json: async () => ({ generation: 1, active: { backend: 'sqlite' }, migrations: [] }) };
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(FeedbackStoragePanel)); });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-backend' }).props.onChange({ target: { value: 'postgresql' } }); });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-authentication' }).props.onChange({ target: { value: 'bytepg' } }); });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-token-source' }).props.onChange({ target: { value: 'doas' } }); });
    await act(async () => {
      renderer.root.findByProps({ id: 'feedback-storage-compute-id' }).props.onChange({ target: { value: 'cp-test' } });
      renderer.root.findByProps({ id: 'feedback-storage-doas-psm' }).props.onChange({ target: { value: 'data.example.service' } });
    });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-save' }).props.onClick(); });
    expect(writes[0].candidate.postgres.bytepg).toEqual({ computeId: 'cp-test', doas: { psm: 'data.example.service', environment: 'boe' } });
    expect(writes[0]).not.toHaveProperty('token');
    await act(async () => renderer.unmount());
  });
  it('offers BytePG token authentication and never reuses a password as the token', async () => {
    const writes: any[] = [];
    vi.stubGlobal('fetch', async (_url: string, options?: RequestInit) => {
      if (options?.method === 'POST') writes.push(JSON.parse(String(options.body)));
      return { ok: true, status: 200, json: async () => ({ generation: 1, active: { backend: 'sqlite' }, migrations: [] }) };
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(FeedbackStoragePanel)); });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-backend' }).props.onChange({ target: { value: 'postgresql' } }); });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-authentication' }).props.onChange({ target: { value: 'bytepg' } }); });
    await act(async () => {
      renderer.root.findByProps({ id: 'feedback-storage-compute-id' }).props.onChange({ target: { value: 'cp-test-compute' } });
      renderer.root.findByProps({ id: 'feedback-storage-token' }).props.onChange({ target: { value: 'synthetic-ui-token' } });
    });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-save' }).props.onClick(); });
    expect(writes[0]).toMatchObject({ token: 'synthetic-ui-token', candidate: { postgres: { bytepg: { computeId: 'cp-test-compute', tokenRef: '' } } } });
    expect(writes[0]).not.toHaveProperty('password');
    expect(renderer.root.findByProps({ id: 'feedback-storage-token' }).props.value).toBe('');
    await act(async () => renderer.unmount());
  });
  it('keeps cancellation disabled until explicit confirmation and evidence are supplied', async () => {
    const writes: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') writes.push({ url, body: JSON.parse(String(options.body)) });
      return { ok: true, status: 200, json: async () => ({ generation: 1, active: { backend: 'sqlite' }, migrations: [{ migrationId: 'blocked-job', phase: 'blocked', blockers: [] }] }) };
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(FeedbackStoragePanel)); });
    expect(renderer.root.findByProps({ id: 'feedback-storage-cancel' }).props.disabled).toBe(true);
    await act(async () => {
      renderer.root.findByProps({ id: 'feedback-recovery-reason' }).props.onChange({ target: { value: 'cancel bad target' } });
      renderer.root.findByProps({ id: 'feedback-recovery-evidence' }).props.onChange({ target: { value: 'ticket:123' } });
      renderer.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } });
    });
    expect(renderer.root.findByProps({ id: 'feedback-storage-cancel' }).props.disabled).toBe(false);
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-cancel' }).props.onClick(); });
    expect(writes[0]).toEqual({ url: '/api/feedback/storage/migrations/blocked-job/cancel', body: { confirmed: true, reason: 'cancel bad target', evidence: 'ticket:123' } });
    await act(async () => renderer.unmount());
  });
  it('mints a fresh migration requestId after a cancellation instead of silently resuming the cancelled job', async () => {
    const writes: Array<{ url: string; body: any }> = [];
    let phase: 'blocked' | 'cancelled' | undefined;
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (options?.method === 'POST') writes.push({ url, body: JSON.parse(String(options.body)) });
      return { ok: true, status: 200, json: async () => ({ generation: 1, active: { backend: 'sqlite' }, candidate: { backend: 'postgresql' }, migrations: phase ? [{ migrationId: 'job-a', phase, blockers: [] }] : [] }) };
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(FeedbackStoragePanel)); });
    await act(async () => { renderer.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } }); });
    phase = 'blocked';
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-migrate' }).props.onClick(); });
    await act(async () => {
      renderer.root.findByProps({ id: 'feedback-recovery-reason' }).props.onChange({ target: { value: 'wrong candidate' } });
      renderer.root.findByProps({ id: 'feedback-recovery-evidence' }).props.onChange({ target: { value: 'ticket:123' } });
    });
    phase = 'cancelled';
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-cancel' }).props.onClick(); });
    await act(async () => { renderer.root.findByProps({ id: 'feedback-storage-migrate' }).props.onClick(); });
    const migrateWrites = writes.filter(write => write.url.endsWith('/migrate'));
    expect(migrateWrites).toHaveLength(2);
    expect(migrateWrites[0].body.requestId).toEqual(expect.any(String));
    expect(migrateWrites[1].body.requestId).toEqual(expect.any(String));
    expect(migrateWrites[1].body.requestId).not.toBe(migrateWrites[0].body.requestId);
    await act(async () => renderer.unmount());
  });
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
