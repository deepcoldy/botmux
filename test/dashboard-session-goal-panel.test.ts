import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionGoalPanel } from '../src/dashboard/web/session-goal-panel.js';
import { confirm } from '../src/dashboard/web/confirm-modal.js';
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: vi.fn(async () => true) }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.unstubAllGlobals());

async function render(actions: string[], blockedReason?: string) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
    ok: true, json: async () => init?.method === 'POST' ? { ok: true, accepted: true } : { ok: true, actions, blockedReason },
  }));
  vi.stubGlobal('fetch', fetchMock);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(SessionGoalPanel, { sessionId: 's1' })); });
  return { renderer, fetchMock };
}
describe('Dashboard goal frontend controls', () => {
  it('starts a goal from a visible form and does not expose undeclared controls', async () => {
    const { renderer, fetchMock } = await render(['start', 'status']);
    expect(renderer.root.findAllByProps({ 'data-goal-action': 'pause' })).toHaveLength(0);
    expect(renderer.root.findByProps({ 'data-goal-action': 'start' }).props.disabled).toBe(true);
    await act(async () => { renderer.root.findByType('textarea').props.onChange({ target: { value: 'Fix login and pass tests' } }); });
    await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sessions/s1/goal', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ action: 'start', objective: 'Fix login and pass tests' }),
    }));
    await act(async () => renderer.unmount());
  });
  it('submits supported pause and resume controls', async () => {
    const { renderer, fetchMock } = await render(['start', 'status', 'pause', 'resume', 'clear']);
    for (const action of ['pause', 'resume']) {
      await act(async () => { await renderer.root.findByProps({ 'data-goal-action': action }).props.onClick(); });
      expect(fetchMock).toHaveBeenLastCalledWith('/api/sessions/s1/goal', expect.objectContaining({ body: JSON.stringify({ action }) }));
    }
    vi.mocked(confirm).mockResolvedValueOnce(false);
    await act(async () => { await renderer.root.findByProps({ 'data-goal-action': 'clear' }).props.onClick(); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await act(async () => renderer.unmount());
  });
  it('disables commands for a runtime without native input', async () => {
    const { renderer, fetchMock } = await render(['start', 'status'], 'goal_input_unsupported');
    expect(renderer.root.findByProps({ 'data-goal-action': 'start' }).props.disabled).toBe(true);
    await act(async () => { renderer.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  });
});
