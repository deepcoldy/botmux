import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BotDefaultsPage, buildSubstituteTarget } from '../src/dashboard/web/bot-defaults-page.js';

// Regression guard for the substitute-target edit path: re-editing a just-resolved email
// target in the same session must not keep the stale resolved open_id (the server prefers
// open_id, so it would substitute the previous person while the UI shows "saved").
describe('buildSubstituteTarget', () => {
  it('drops a stale resolved open_id when a just-resolved email target is re-edited (same session)', () => {
    // add alice@corp.com → Save resolved it to ou_alice, so persisted now carries both;
    // originalIdField is undefined because the row was added this session (never reloaded).
    const target = buildSubstituteTarget({
      idField: 'email',
      idValue: 'bob@corp.com', // user re-typed a different email before the 2nd Save
      name: '',
      persisted: { openId: 'ou_alice', email: 'alice@corp.com', name: 'Alice' },
      originalIdField: undefined,
    });
    expect(target?.email).toBe('bob@corp.com');
    expect(target?.openId).toBeUndefined(); // must re-resolve the new email, not the stale id
  });

  it('keeps the resolved open_id when the row is unchanged (stable id preserved)', () => {
    const target = buildSubstituteTarget({
      idField: 'email',
      idValue: 'alice@corp.com', // unchanged
      name: 'Alice',
      persisted: { openId: 'ou_alice', email: 'alice@corp.com', name: 'Alice' },
      originalIdField: undefined,
    });
    expect(target?.openId).toBe('ou_alice');
    expect(target?.email).toBe('alice@corp.com');
    expect(target?.name).toBe('Alice');
  });

  it('drops the previous id field when the id field is switched', () => {
    const target = buildSubstituteTarget({
      idField: 'email',
      idValue: 'carol@corp.com',
      name: '',
      persisted: { openId: 'ou_carol', name: 'Carol' },
      originalIdField: 'openId',
    });
    expect(target?.email).toBe('carol@corp.com');
    expect(target?.openId).toBeUndefined();
  });

  it('builds a clean target for a brand-new row', () => {
    expect(buildSubstituteTarget({
      idField: 'openId', idValue: 'ou_dan', name: 'Dan', persisted: {}, originalIdField: undefined,
    })).toEqual({ openId: 'ou_dan', name: 'Dan' });
  });

  it('returns null for a blank id value', () => {
    expect(buildSubstituteTarget({
      idField: 'email', idValue: '  ', name: 'x', persisted: {}, originalIdField: undefined,
    })).toBeNull();
  });
});

describe('App ID draft', () => {
  it('only submits App ID, even when a previous target carried resolved person IDs', () => {
    expect(buildSubstituteTarget({ idField: 'appId', idValue: 'cli_external', name: 'Old person', persisted: { openId: 'ou_old', email: 'old@example.com' } })).toEqual({ appId: 'cli_external' });
  });
});


it('saves and reloads one App ID input without a name, group, Open ID or binding picker', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let mode: any = { enabled: true, targets: [{ appId: 'cli_external' }] };
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const puts: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/bots') return Response.json({ bots: [{ larkAppId: 'cli_receiver', cliId: 'riff', substituteMode: mode }] });
    if (url.endsWith('/substitute-mode') && init?.method === 'PUT') {
      mode = JSON.parse(String(init.body)); puts.push(mode);
      return Response.json({ ok: true, substituteMode: mode, resolution: [{ input: mode.targets[0].appId, ok: true, appId: mode.targets[0].appId }] });
    }
    return Response.json({ error: 'fixture_unavailable' }, { status: 404 });
  }));
  const mount = async () => {
    await act(async () => { renderer = TestRenderer.create(React.createElement(BotDefaultsPage)); });
    await act(async () => { renderer!.root.findByProps({ id: 'bd-tab-sessions' }).props.onClick(); });
  };
  try {
    await mount();
    const row = () => renderer!.root.findByProps({ className: 'bd-substitute-target-row' });
    const inputs = () => row().findAllByType('input')
      .filter(node => node.props.type !== 'hidden' && node.props['aria-hidden'] !== true);
    expect(inputs()).toHaveLength(1);
    await act(async () => { inputs()[0].props.onChange({ currentTarget: { value: 'cli_changed' } }); });
    await act(async () => { renderer!.root.findByProps({ 'data-action': 'save-substitute-mode' }).props.onClick(); });
    expect(puts[0].targets).toEqual([{ appId: 'cli_changed' }]);
    await act(async () => { renderer!.unmount(); });
    await mount();
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0].props.value).toBe('cli_changed');
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    vi.unstubAllGlobals();
  }
});
