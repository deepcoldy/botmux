import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { TraexAutoModelEditor } from '../src/dashboard/web/traex-auto-model-editor.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('TraeX Auto preflight editor', () => {
  it('round-trips the admission fields and locks reasoning to the model maximum', () => {
    const onPreflightLoadCheck = vi.fn();
    const onOverloadThresholdPercent = vi.fn();
    const common = {
      enabled: true, trigger: 'capacity' as const, reselectPerTurn: false,
      models: ['max-model'], modelSettings: { 'max-model': { reasoningEffort: 'high' as const } },
      timeoutSeconds: '30', cooldownSeconds: '60', candidates: ['max-model'], busy: false,
      capabilities: [{ slug: 'max-model', serviceTiers: [], reasoningEfforts: ['low', 'xhigh', 'max'] }],
      overloadThresholdPercent: '100', preflightTimeoutSeconds: '8',
      unknownLoadPolicy: 'skip' as const, allOverloadedPolicy: 'lowest_load' as const,
      onEnabled: vi.fn(), onReselectPerTurn: vi.fn(), onModels: vi.fn(), onSettings: vi.fn(),
      onTimeout: vi.fn(), onCooldown: vi.fn(), onPreflightLoadCheck,
      onOverloadThresholdPercent, onPreflightTimeoutSeconds: vi.fn(),
      onUnknownLoadPolicy: vi.fn(), onAllOverloadedPolicy: vi.fn(),
    };
    let view!: TestRenderer.ReactTestRenderer;
    act(() => { view = TestRenderer.create(createElement(TraexAutoModelEditor, {
      ...common, preflightLoadCheck: false,
    })); });
    expect(view.root.findByProps({ 'data-input': 'autoModelPreflightLoadCheck' }).props.checked).toBe(false);
    expect(view.root.findAllByProps({ 'data-input': 'autoModelOverloadThreshold' })).toHaveLength(0);
    act(() => view.root.findByProps({ 'data-input': 'autoModelPreflightLoadCheck' })
      .props.onChange({ currentTarget: { checked: true } }));
    expect(onPreflightLoadCheck).toHaveBeenCalledWith(true);

    act(() => { view.update(createElement(TraexAutoModelEditor, {
      ...common, preflightLoadCheck: true,
    })); });
    const effort = view.root.findByProps({ dataInput: 'autoModelEffort0' });
    expect(effort.props.value).toBe('max');
    expect(effort.props.disabled).toBe(true);
    act(() => view.root.findByProps({ 'data-input': 'autoModelOverloadThreshold' })
      .props.onChange({ currentTarget: { value: '101' } }));
    expect(onOverloadThresholdPercent).toHaveBeenCalledWith('101');
    expect(view.root.findByProps({ dataInput: 'autoModelUnknownLoadPolicy' }).props.value).toBe('skip');
    expect(view.root.findByProps({ dataInput: 'autoModelAllOverloadedPolicy' }).props.value).toBe('lowest_load');
    act(() => view.unmount());
  });
});
