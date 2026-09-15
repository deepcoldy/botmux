import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuietPresetSection } from '../src/dashboard/web/quiet-preset-section.js';
import { toast } from '../src/dashboard/web/toast.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../src/dashboard/web/toast.js', () => ({ toast: vi.fn() }));

const tr = (key: string) => key;

async function settle(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => { await Promise.resolve(); });
  }
}

function renderSection(overrides?: Partial<{
  thinkingCard: boolean;
  silentReactions: boolean;
  disableStreaming: boolean;
}>) {
  const putCardPref = vi.fn(async () => ({ ok: true, status: 200, body: { ok: true } }));
  const onApplied = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  const props = {
    tr,
    thinkingCard: true,
    silentReactions: false,
    disableStreaming: false,
    putCardPref,
    onApplied,
    ...overrides,
  };
  act(() => {
    renderer = TestRenderer.create(React.createElement(QuietPresetSection, props));
  });
  return { renderer, putCardPref, onApplied, props };
}

function switchInput(renderer: TestRenderer.ReactTestRenderer): any {
  return renderer.root.findByProps({ 'data-action': 'quiet-preset-switch' });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('QuietPresetSection', () => {
  it('starts off when the derived three-way condition is not met and writes nothing', async () => {
    const { putCardPref, renderer } = renderSection();
    expect(switchInput(renderer).props.checked).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-quiet-preset-details': true })).toHaveLength(0);
    expect(renderer.root.findAllByProps({ 'data-quiet-preset-off-note': true })).toHaveLength(1);
    expect(putCardPref).not.toHaveBeenCalled();
  });

  it('starts on (details visible) when all three current values already match', () => {
    const { renderer, putCardPref } = renderSection({
      thinkingCard: false,
      silentReactions: true,
      disableStreaming: true,
    });
    expect(switchInput(renderer).props.checked).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-quiet-preset-details': true })).toHaveLength(1);
    expect(putCardPref).not.toHaveBeenCalled();
  });

  it('ON performs exactly one PUT with exactly the three required keys, syncs parent, toasts', async () => {
    const { renderer, putCardPref, onApplied, props } = renderSection();

    await act(async () => {
      switchInput(renderer).props.onChange({ currentTarget: { checked: true } });
    });
    await settle();

    expect(putCardPref).toHaveBeenCalledTimes(1);
    const patch = putCardPref.mock.calls[0]![0];
    expect(patch).toEqual({
      thinkingCard: false,
      silentTurnReactions: true,
      disableStreamingCard: true,
    });
    expect(Object.keys(patch)).toHaveLength(3);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('quietPreset.onToast', expect.objectContaining({ kind: 'success' }));

    // Parent re-renders with the synced values: preset stays on, no new write.
    await act(async () => {
      renderer.update(React.createElement(QuietPresetSection, {
        ...props,
        thinkingCard: false,
        silentReactions: true,
        disableStreaming: true,
      }));
    });
    expect(switchInput(renderer).props.checked).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-quiet-preset-details': true })).toHaveLength(1);
    expect(putCardPref).toHaveBeenCalledTimes(1);
  });

  it('auto-flips off after an original toggle is edited (derived false), with no new write', async () => {
    const { renderer, putCardPref, props } = renderSection({
      thinkingCard: false,
      silentReactions: true,
      disableStreaming: true,
    });
    expect(switchInput(renderer).props.checked).toBe(true);

    // User edits the thinking-card toggle directly on the parent.
    await act(async () => {
      renderer.update(React.createElement(QuietPresetSection, { ...props, thinkingCard: true }));
    });
    await settle();

    expect(switchInput(renderer).props.checked).toBe(false);
    expect(renderer.root.findAllByProps({ 'data-quiet-preset-off-note': true })).toHaveLength(1);
    expect(putCardPref).not.toHaveBeenCalled();
  });

  it('OFF sends zero write requests and keeps switch values untouched', async () => {
    const { renderer, putCardPref, onApplied } = renderSection({
      thinkingCard: false,
      silentReactions: true,
      disableStreaming: true,
    });

    await act(async () => {
      switchInput(renderer).props.onChange({ currentTarget: { checked: false } });
    });
    await settle();

    expect(switchInput(renderer).props.checked).toBe(false);
    expect(putCardPref).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });
});
