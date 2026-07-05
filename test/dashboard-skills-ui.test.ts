import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { BotPolicyCard, SkillsInstallPanel } from '../src/dashboard/web/skills-page.js';

describe('dashboard skills React hook safety', () => {
  it('keeps hook order stable when the same bot card flips between error and normal states', () => {
    const onUpdate = vi.fn();
    const normalBot = { larkAppId: 'app-a', botName: 'Codex Bot', skills: { include: ['skill:deploy'] } };
    const errorBot = { larkAppId: 'app-a', botName: 'Codex Bot', error: 'daemon offline', skills: null };
    const skills = [{ name: 'deploy' }, { name: 'review' }];

    let renderer!: TestRenderer.ReactTestRenderer;
    expect(() => {
      act(() => {
        renderer = TestRenderer.create(React.createElement(BotPolicyCard, {
          bot: errorBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onUpdate,
        }));
      });
      act(() => {
        renderer.update(React.createElement(BotPolicyCard, {
          bot: normalBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onUpdate,
        }));
      });
      act(() => {
        renderer.update(React.createElement(BotPolicyCard, {
          bot: errorBot,
          installedNames: new Set(['deploy', 'review']),
          skills,
          status: null,
          busyKey: null,
          onUpdate,
        }));
      });
    }).not.toThrow();

    expect(renderer.toJSON()).toMatchObject({ props: { 'data-appid': 'app-a' } });
  });
});

describe('dashboard skills install panel', () => {
  it('separates remote source scanning from local native skill discovery', () => {
    const renderer = TestRenderer.create(React.createElement(SkillsInstallPanel, {
      installSource: '',
      installPath: '',
      installRef: '',
      installStatus: null,
      installBusy: false,
      onInstallSourceChange: vi.fn(),
      onInstallPathChange: vi.fn(),
      onInstallRefChange: vi.fn(),
      onInstall: vi.fn(),
      onOpenNativeDiscovery: vi.fn(),
    }));
    const root = renderer.root;

    const sourceControl = root.findByProps({ className: 'skills-source-control' });
    expect(sourceControl.findAllByProps({ 'data-action': 'discover-native-skills' })).toHaveLength(0);
    expect(root.findAllByProps({ 'data-action': 'open-native-skill-discovery' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-action': 'install' })).toHaveLength(1);
    expect(root.findByProps({ 'data-skills-advanced': true }).props.open).toBe(false);
  });
});
