import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { UpdateCard } from '../src/dashboard/web/settings-page.js';

function render(status: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  const onInstallRelease = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(React.createElement(UpdateCard, {
    canWrite: true, statusError: null, changelog: null, changelogOpen: false,
    changelogOk: true, changelogRateLimited: false, releasesUrl: '', busy: false, message: null,
    onCheck: vi.fn(), onToggleChangelog: vi.fn(), onUpdate: vi.fn(), onForceUpdate: vi.fn(),
    onRestart: vi.fn(), onInstallRelease,
    status: { current: '3.59.27', latest: '3.59.27', behind: false, cliBehind: false, cliUpdates: [],
      localDevInstall: true, localDevUpdatable: false, sourceReleaseAvailable: true,
      updateSupported: false, updateManager: 'unknown', updateCommand: null,
      node: { ok: true, version: '22.20.0', required: '22' }, installs: { entries: [], multiple: false },
      ...status } as any,
    ...overrides,
  })); });
  return { renderer, onInstallRelease };
}

describe('source release recovery control', () => {
  it('remains actionable when Git updates are unavailable, including the same official version', () => {
    const { renderer, onInstallRelease } = render();
    expect(renderer.root.findByProps({ 'data-up': 'update' }).props.disabled).toBe(true);
    const button = renderer.root.findByProps({ 'data-up': 'install-release' });
    expect(button.props.disabled).toBe(false);
    act(() => { button.props.onClick(); });
    expect(onInstallRelease).toHaveBeenCalledTimes(1);
  });
  it.each([{ latest: null }, {}])('disables migration without a resolved version or while busy: %j', status => {
    const { renderer } = render(status, 'latest' in status ? {} : { busy: true });
    expect(renderer.root.findByProps({ 'data-up': 'install-release' }).props.disabled).toBe(true);
  });
  it('hides migration for unsupported hosts and users without management access', () => {
    for (const fixture of [render({ sourceReleaseAvailable: false }), render({}, { canWrite: false })]) {
      expect(fixture.renderer.root.findAllByProps({ 'data-up': 'install-release' })).toHaveLength(0);
    }
  });
  it('surfaces an installed release awaiting restart after a page reload', () => {
    const { renderer } = render({ sourceReleaseAvailable: false, sourceReleasePending: true });
    expect(renderer.root.findAllByProps({ 'data-source-release-pending': true })).toHaveLength(1);
    expect(renderer.root.findByProps({ 'data-up': 'restart' }).props.disabled).toBe(false);
  });
});
