import React, { type ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { UpdateCard } from '../src/dashboard/web/settings-page.js';
import { confirmLocalForceUpdate, localForceUpdateError } from '../src/dashboard/web/update-action.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const tr = createDashboardTranslator('en');
const preview = { ok: true, token: 'confirmation', dir: '/source', target: 'refs/remotes/origin/master',
  targetHead: '0123456789abcdef', status: ' M feature.txt\n?? draft.txt', localCommits: '1234567 custom feature' };

describe('force update confirmation', () => {
  it.each(['local_update_shared_deps', 'local_update_untracked_directory'])('translates %s instead of exposing filesystem errors', async code => {
    for (const locale of ['zh', 'en'] as const) {
      const translate = createDashboardTranslator(locale);
      const expected = translate(`update.${code}`);
      expect(expected).not.toBe(`update.${code}`);
      expect(localForceUpdateError({ error: code, detail: 'raw filesystem error' }, translate)).toBe(expected);
      const confirmImpl = vi.fn();
      await expect(confirmLocalForceUpdate(vi.fn().mockResolvedValue(Response.json({ error: code, detail: 'raw filesystem error' }, { status: 409 })), confirmImpl, translate)).rejects.toThrow(expected);
      expect(confirmImpl).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('returns a single-use token only when accepted=%s, after showing files and commits', async accepted => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(preview));
    const confirmImpl = vi.fn().mockResolvedValue(accepted);
    await expect(confirmLocalForceUpdate(fetchImpl, confirmImpl, tr)).resolves.toBe(accepted ? preview.token : null);
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith('/api/update/local-dev/preview', { method: 'POST' });
    expect(confirmImpl).toHaveBeenCalledWith(expect.objectContaining({ danger: true,
      message: expect.stringContaining('draft.txt') }));
    expect(confirmImpl.mock.calls[0][0].message).toContain('custom feature');
    expect(confirmImpl.mock.calls[0][0].message).toContain('/source');
  });
  it('does not ask for confirmation when preview failed', async () => {
    const confirmImpl = vi.fn();
    await expect(confirmLocalForceUpdate(vi.fn().mockResolvedValue(Response.json({ error: 'local_update_preview_stale' }, { status: 409 })), confirmImpl, tr)).rejects.toThrow();
    expect(confirmImpl).not.toHaveBeenCalled();
  });
  it.each(['local', 'global', 'readonly', 'busy'] as const)('offers force update only for an operable local source install (%s)', async mode => {
    const onForceUpdate = vi.fn();
    const props: ComponentProps<typeof UpdateCard> = {
      canWrite: mode !== 'readonly', busy: mode === 'busy', statusError: null, message: null,
      changelog: null, changelogOpen: false, changelogOk: true, changelogRateLimited: false, releasesUrl: '',
      status: { current: '3.56.0', latest: '3.56.0', behind: false, localDevInstall: mode !== 'global', localDevUpdatable: true,
        updateSupported: true, updateCommand: 'update', node: { ok: true, version: '22.0.0', required: '22.0.0' },
        installs: { multiple: false, entries: [] } } as ComponentProps<typeof UpdateCard>['status'],
      onCheck: vi.fn(), onToggleChangelog: vi.fn(), onUpdate: vi.fn(), onRestart: vi.fn(), onForceUpdate,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(UpdateCard, props)); });
    const buttons = renderer.root.findAll(node => node.type === 'button' && node.props['data-up'] === 'force-update');
    if (mode === 'global' || mode === 'readonly') expect(buttons).toHaveLength(0);
    else {
      expect(buttons).toHaveLength(1);
      expect(buttons[0].props.disabled).toBe(mode === 'busy');
      if (mode === 'local') { await act(async () => buttons[0].props.onClick()); expect(onForceUpdate).toHaveBeenCalledOnce(); }
    }
    await act(async () => renderer.unmount());
  });
});
