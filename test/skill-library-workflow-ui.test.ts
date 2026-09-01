import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'bun:test';
import { SkillsInstallPanel } from '../src/dashboard/web/skills-page.js';
import { SkillLibraryTab } from '../src/dashboard/web/skills/skill-library-tab.js';
import { DeliverySettingsTab } from '../src/dashboard/web/skills/delivery-settings-tab.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const Empty = () => null;

function libraryProps(over: Record<string, unknown> = {}) {
  return {
    skills: [],
    nativeSkillGroups: [],
    installSource: 'https://github.com/example/skills',
    installPath: '',
    installRef: '',
    installFullDepth: false,
    installStatus: null,
    installBusy: false,
    installDiscovering: false,
    installSelectionOpen: true,
    installCandidates: [
      { name: 'deploy', path: 'skills/deploy' },
      { name: 'oncall', path: 'skills/oncall' },
    ],
    selectedInstallSkills: new Set(['deploy', 'oncall']),
    onInstallSourceChange: () => {},
    onInstallPathChange: () => {},
    onInstallRefChange: () => {},
    onInstallFullDepthChange: () => {},
    onToggleInstallSkill: () => {},
    onSelectAllInstallSkills: () => {},
    onConfirmInstallSelection: async () => ['deploy', 'oncall'],
    onCloseInstallSelection: () => {},
    onInstall: async () => null,
    onOpenNativeDiscovery: () => {},
    onCreatePack: async () => {},
    InstallPanel: SkillsInstallPanel,
    InstalledLibrary: Empty,
    RemoveDialog: Empty,
    removingNames: new Set<string>(),
    removalDialogOpen: false,
    pendingRemoval: null,
    removalReferences: [],
    removalError: null,
    skillBusy: null,
    installedStatus: null,
    onUpdateSkill: () => {},
    onRequestRemove: () => {},
    onCancelRemoval: () => {},
    onConfirmRemoval: () => {},
    ...over,
  };
}

describe('Skill install to Pack workflow', () => {
  it('keeps multi-Skill selection in the confirmation dialog and offers a Pack after install', async () => {
    const onConfirmInstallSelection = vi.fn(async () => ['deploy', 'oncall']);
    const onCreatePack = vi.fn(async () => {});
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(React.createElement(SkillLibraryTab, libraryProps({
        onConfirmInstallSelection,
        onCreatePack,
      })));
    });

    const root = renderer.root;
    expect(root.findAllByProps({ 'data-install': 'source' })).toHaveLength(1);
    expect(root.findAllByProps({ 'data-install-selection-dialog': true })).toHaveLength(1);
    expect(JSON.stringify(renderer.toJSON())).toContain('deploy');
    expect(JSON.stringify(renderer.toJSON())).toContain('oncall');

    const installSelected = root.findAllByType('button').find((button: any) => button.props.children === '安装选中');
    await act(async () => { await installSelected!.props.onClick(); });
    expect(onConfirmInstallSelection).toHaveBeenCalledTimes(1);

    const packDialog = root.findAllByType('dialog').find((dialog: any) => String(dialog.props.className).includes('post-install-pack'));
    expect(packDialog).toBeDefined();
    const inputs = packDialog!.findAllByType('input');
    act(() => {
      inputs[0].props.onChange({ target: { value: 'ops-pack' } });
      inputs[1].props.onChange({ target: { value: '运维专项包' } });
    });
    const form = packDialog!.findByType('form');
    await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
    expect(onCreatePack).toHaveBeenCalledWith({
      id: 'ops-pack',
      name: '运维专项包',
      skillNames: ['deploy', 'oncall'],
    });
  });
});

describe('Skill delivery defaults', () => {
  it('shows the backend prompt default instead of treating an unset override as global', () => {
    const values: string[] = [];
    const SkillSegmented = (props: any) => {
      values.push(props.value);
      return React.createElement('span', { 'data-value': props.value });
    };
    act(() => {
      TestRenderer.create(React.createElement(DeliverySettingsTab, {
        trustProjectSkills: 'off',
        delivery: 'auto',
        globalBusy: null,
        onUpdateProject: () => {},
        onUpdateDelivery: () => {},
        bots: [{
          larkAppId: 'bot-1',
          cliId: 'codex',
          skillInjection: null,
          skillInjectionDefault: 'prompt',
        }],
        onUpdateBotInjection: () => {},
        botStatuses: {},
        SkillSegmented,
      }));
    });
    expect(values.at(-1)).toBe('prompt');
  });
});
