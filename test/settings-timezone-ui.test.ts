import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { TimeZoneRow } from '../src/dashboard/web/settings-page.js';

/** Find the single <input> node in the rendered tree. */
function findInput(r: TestRenderer.ReactTestRenderer) {
  return r.root.findByType('input');
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
    const input = findInput(r);
    expect(input.props.value).toBe('Asia/Shanghai');
    expect(input.props.placeholder).toBe('America/Los_Angeles');
    const options = r.root.findAllByType('option');
    expect(options.some(o => o.props.value === 'Asia/Shanghai')).toBe(true);
    const hint = String(r.root.findByType('small').props.children);
    expect(hint).toContain('America/Los_Angeles'); // host
    expect(hint).toContain('Asia/Shanghai');        // effective
  });

  it('empty value ⇒ placeholder = host; effective (=host) shown in hint', () => {
    const { r } = render({ value: '', host: 'America/Los_Angeles', effective: 'America/Los_Angeles' });
    expect(findInput(r).props.value).toBe('');
    expect(String(r.root.findByType('small').props.children)).toContain('America/Los_Angeles');
  });

  it('env override: hint shows the backend effective (NOT configured||host)', () => {
    // env BOTMUX_SCHEDULE_TIMEZONE=Asia/Tokyo → configured empty, host LA, but the
    // TRUE effective is Tokyo. The hint must reflect Tokyo, not host/configured.
    const { r } = render({ value: '', host: 'America/Los_Angeles', effective: 'Asia/Tokyo' });
    const hint = String(r.root.findByType('small').props.children);
    expect(hint).toContain('Asia/Tokyo');
  });

  it('commits a new zone on blur (fires onSave with the trimmed value)', () => {
    const onSave = vi.fn();
    const { r } = render({ onSave });
    const input = findInput(r);
    act(() => { input.props.onChange({ currentTarget: { value: '  Asia/Tokyo  ' } }); });
    act(() => { input.props.onBlur(); });
    expect(onSave).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('clearing the field to empty commits null (clear override → follow host)', () => {
    const onSave = vi.fn();
    const { r } = render({ value: 'Asia/Shanghai', onSave });
    const input = findInput(r);
    act(() => { input.props.onChange({ currentTarget: { value: '' } }); });
    act(() => { input.props.onBlur(); });
    expect(onSave).toHaveBeenCalledWith(null);
  });

  it('does NOT fire onSave when the value is unchanged on blur', () => {
    const onSave = vi.fn();
    const { r } = render({ value: 'Asia/Shanghai', onSave });
    act(() => { findInput(r).props.onBlur(); });
    expect(onSave).not.toHaveBeenCalled();
  });
});
