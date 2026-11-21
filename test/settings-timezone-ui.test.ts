import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { TimeZoneRow } from '../src/dashboard/web/settings-page.js';
import { DropdownMenu, FieldTitle, type DropdownOption } from '../src/dashboard/web/dashboard-components.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function findMenu(r: TestRenderer.ReactTestRenderer) {
  return r.root.findByType(DropdownMenu);
}

function optionLabel(r: TestRenderer.ReactTestRenderer, value: string): string {
  const options = findMenu(r).props.options as DropdownOption<string>[];
  return String(options.find(option => option.value === value)?.label ?? '');
}

function pick(r: TestRenderer.ReactTestRenderer, value: string): void {
  act(() => { findMenu(r).props.onChange(value); });
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
    expect(findMenu(r).props.label).toBe('Asia/Shanghai');
    expect(findMenu(r).props.value).toBe('Asia/Shanghai');
    expect(optionLabel(r, '')).toContain('America/Los_Angeles');
    const hint = findHint(r);
    expect(hint).toContain('America/Los_Angeles'); // host
    expect(hint).toContain('Asia/Shanghai');        // effective
  });

  it('empty value ⇒ placeholder = host; effective (=host) shown in hint', () => {
    const { r } = render({ value: '', host: 'America/Los_Angeles', effective: 'America/Los_Angeles' });
    expect(String(findMenu(r).props.label)).toContain('America/Los_Angeles');
    expect(findMenu(r).props.value).toBe('');
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
    expect(optionLabel(r, 'Asia/Tokyo')).toBe('Asia/Tokyo');
    pick(r, 'Asia/Tokyo');
    expect(onSave).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('selecting the host option commits null (clear override → follow host)', () => {
    const onSave = vi.fn();
    const { r } = render({ value: 'Asia/Shanghai', onSave });
    pick(r, '');
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('leaves re-selecting the current value to the menu no-op guard', () => {
    // DropdownMenu drops a same-value pick unless notifyOnReselect is set
    // (covered in dashboard-dropdown-menu.test.ts); an auto-saving row must not opt in.
    const { r } = render({ value: 'Asia/Shanghai' });
    expect(findMenu(r).props.notifyOnReselect).toBeFalsy();
  });

  it('marks the dropdown disabled when requested', () => {
    const { r } = render({ disabled: true });
    expect(findMenu(r).props.disabled).toBe(true);
  });
});
