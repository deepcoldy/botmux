import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { TimeZoneRow } from '../src/dashboard/web/settings-page.js';
import { FieldTitle } from '../src/dashboard/web/dashboard-components.js';

function findMenu(r: TestRenderer.ReactTestRenderer) {
  return r.root.findByType('details');
}

function findSummaryText(r: TestRenderer.ReactTestRenderer): string {
  const value = r.root.findByProps({ className: 'sect-sort-value' });
  return value.children.join('');
}

function findOptionButton(r: TestRenderer.ReactTestRenderer, label: string) {
  return r.root.findAllByType('button').find(button => button.children.join('') === label);
}

function clickOption(button: TestRenderer.ReactTestInstance): void {
  act(() => {
    button.props.onClick({
      currentTarget: { closest: () => ({ removeAttribute: vi.fn() }) },
    });
  });
}

/**
 * The effective-zone hint moved from an inline <small> into the field title's `?` InfoTip
 * (its `help` prop) per the dashboard UI baseline; assert on that help text.
 */
function findHint(r: TestRenderer.ReactTestRenderer): string {
  return String(r.root.findByType(FieldTitle).props.help);
}

type RowProps = { value: string; host: string; effective: string; disabled: boolean; onSave: (tz: string | null) => void };
function render(over: Partial<RowProps> = {}) {
  const props: RowProps = {
    value: 'Asia/Shanghai', host: 'America/Los_Angeles', effective: 'Asia/Shanghai',
    disabled: false, onSave: vi.fn(), ...over,
  };
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(React.createElement(TimeZoneRow, props)); });
  return { r, props };
}

describe('TimeZoneRow (dashboard settings)', () => {
  it('renders the configured value + host placeholder + effective hint', () => {
    const { r } = render({ value: 'Asia/Shanghai', host: 'America/Los_Angeles', effective: 'Asia/Shanghai' });
    expect(findSummaryText(r)).toBe('Asia/Shanghai');
    const buttons = r.root.findAllByType('button');
    expect(buttons.some(o => o.children.join('').includes('America/Los_Angeles'))).toBe(true);
    expect(findOptionButton(r, 'Asia/Shanghai')?.props['aria-current']).toBe('true');
    const hint = findHint(r);
    expect(hint).toContain('America/Los_Angeles'); // host
    expect(hint).toContain('Asia/Shanghai');        // effective
  });

  it('empty value ⇒ placeholder = host; effective (=host) shown in hint', () => {
    const { r } = render({ value: '', host: 'America/Los_Angeles', effective: 'America/Los_Angeles' });
    expect(findSummaryText(r)).toContain('America/Los_Angeles');
    expect(r.root.findAllByType('button').find(button => button.props['aria-current'] === 'true')?.children.join('')).toContain('America/Los_Angeles');
    expect(findHint(r)).toContain('America/Los_Angeles');
  });

  it('env override: hint shows the backend effective (NOT configured||host)', () => {
    // env BOTMUX_SCHEDULE_TIMEZONE=Asia/Tokyo → configured empty, host LA, but the
    // TRUE effective is Tokyo. The hint must reflect Tokyo, not host/configured.
    const { r } = render({ value: '', host: 'America/Los_Angeles', effective: 'Asia/Tokyo' });
    const hint = findHint(r);
    expect(hint).toContain('Asia/Tokyo');
  });

  it('commits a new zone when selecting a menu option', () => {
    const onSave = vi.fn();
    const { r } = render({ onSave });
    const option = findOptionButton(r, 'Asia/Tokyo');
    expect(option).toBeTruthy();
    clickOption(option!);
    expect(onSave).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('selecting the host option commits null (clear override → follow host)', () => {
    const onSave = vi.fn();
    const { r } = render({ value: 'Asia/Shanghai', onSave });
    const hostOption = r.root.findAllByType('button').find(button => button.children.join('').includes('America/Los_Angeles'));
    expect(hostOption).toBeTruthy();
    clickOption(hostOption!);
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('does NOT fire onSave when re-selecting the current value', () => {
    const onSave = vi.fn();
    const { r } = render({ value: 'Asia/Shanghai', onSave });
    const option = findOptionButton(r, 'Asia/Shanghai');
    expect(option).toBeTruthy();
    clickOption(option!);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('marks the dropdown disabled when requested', () => {
    const { r } = render({ disabled: true });
    expect(findMenu(r).props.className).toContain('is-disabled');
    expect(r.root.findByType('summary').props['aria-disabled']).toBe(true);
  });
});
