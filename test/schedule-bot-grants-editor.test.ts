import React, { type ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: vi.fn(async () => true) }));

import { ScheduleBotGrantsEditor, scheduleBotGrantDraftProblem } from '../src/dashboard/web/schedule-bot-grants-editor.js';
import { confirm } from '../src/dashboard/web/confirm-modal.js';
import { applySettingsWrite, type SettingsWriteApplierDeps } from '../src/dashboard/settings-write-applier.js';
import type { ScheduleBotGrant } from '../src/global-config.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof ScheduleBotGrantsEditor>;
const team: ScheduleBotGrant = { id: 'team', sourceAppId: 'cli_source', targetAppIds: ['cli_a'],
  chatIds: ['oc_team'], controllerUnionId: 'on_admin' };
const botOptions = [
  { larkAppId: 'cli_source', botName: 'Orchestrator' },
  { larkAppId: 'cli_a', botName: 'Stage A' },
  { larkAppId: 'cli_b', botName: 'Stage B' },
];

function render(overrides: Partial<Props> = {}) {
  const onSave = vi.fn(async () => undefined);
  const props: Props = { grants: [], botOptions, createEnabled: true, disabled: false, onSave, ...overrides };
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => { renderer = TestRenderer.create(React.createElement(ScheduleBotGrantsEditor, props)); });
  return { renderer, onSave: props.onSave as typeof onSave };
}
const byAction = (r: TestRenderer.ReactTestRenderer, action: string) => r.root.findAllByProps({ 'data-action': action })
  .find(node => node.type === 'button')!;
const typeInto = (r: TestRenderer.ReactTestRenderer, input: string, value: string) => {
  act(() => { r.root.findByProps({ 'data-input': input }).props.onChange({ currentTarget: { value } }); });
};
const pickSource = (r: TestRenderer.ReactTestRenderer, name: string) => {
  const summary = r.root.findAllByType('summary').find(node => node.props['aria-label'] === '来源 Bot')!;
  const option = summary.parent!.findAllByType('button').find(b => JSON.stringify(b.props.children ?? '').includes(name))!;
  act(() => { option.props.onClick?.({}); });
};
const checkTarget = (r: TestRenderer.ReactTestRenderer, appId: string) => {
  const box = r.root.findAllByType('input').find(node => node.props.type === 'checkbox' && node.props.value === appId)!;
  act(() => { box.props.onChange({ currentTarget: { checked: true } }); });
};
function fill(r: TestRenderer.ReactTestRenderer, grant: { id: string; source: string; targets: string[]; chats: string; controller: string }) {
  act(() => { byAction(r, 'add-grant').props.onClick(); });
  typeInto(r, 'grant-id', grant.id);
  pickSource(r, grant.source);
  for (const target of grant.targets) checkTarget(r, target);
  typeInto(r, 'grant-chats', grant.chats);
  typeInto(r, 'grant-controller', grant.controller);
}
const problemKey = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll(node => node.props['data-bot-grant-problem'] !== undefined)[0]?.props['data-bot-grant-problem'];

describe('ScheduleBotGrantsEditor', () => {
  it('adds a grant and saves the whole list in its stored form', async () => {
    const { renderer, onSave } = render({ grants: [team] });
    fill(renderer, { id: ' polling ', source: 'Orchestrator', targets: ['cli_b'], chats: 'oc_x, oc_y oc_x', controller: ' on_admin ' });
    expect(problemKey(renderer)).toBeUndefined();
    await act(async () => { byAction(renderer, 'save-grant').props.onClick(); });
    expect(onSave).toHaveBeenCalledWith([team, { id: 'polling', sourceAppId: 'cli_source',
      targetAppIds: ['cli_b'], chatIds: ['oc_x', 'oc_y'], controllerUnionId: 'on_admin' }]);
  });

  it('keeps an overlapping grant from being saved and names the one it clashes with', () => {
    const { renderer, onSave } = render({ grants: [team] });
    fill(renderer, { id: 'second', source: 'Orchestrator', targets: ['cli_a', 'cli_b'], chats: 'oc_team', controller: 'on_admin' });
    expect(problemKey(renderer)).toBe('settings.scheduleBotGrantsOverlap');
    expect(JSON.stringify(renderer.toJSON())).toContain('team');
    expect(byAction(renderer, 'save-grant').props.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('refuses an app-scoped open_id as the controller', () => {
    const { renderer } = render();
    fill(renderer, { id: 'team', source: 'Orchestrator', targets: ['cli_a'], chats: 'oc_team', controller: 'ou_admin' });
    expect(problemKey(renderer)).toBe('settings.scheduleBotGrantsControllerInvalid');
    expect(byAction(renderer, 'save-grant').props.disabled).toBe(true);
  });

  it('removes a grant only after confirmation', async () => {
    const { renderer, onSave } = render({ grants: [team, { ...team, id: 'other', chatIds: ['oc_other'] }] });
    await act(async () => { renderer.root.findAllByProps({ 'data-action': 'remove-grant' })
      .filter(node => node.type === 'button')[0]!.props.onClick(); });
    expect(confirm).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith([{ ...team, id: 'other', chatIds: ['oc_other'] }]);
  });

  it('warns that hand-edited grants it cannot show would be dropped by a save', () => {
    const { renderer } = render({ grants: [team], ignoredCount: 2 });
    expect(renderer.root.findAll(node => node.props['data-bot-grants-ignored'] === 2).length).toBeGreaterThan(0);
    expect(render({ grants: [team] }).renderer.root.findAll(node => node.props['data-bot-grants-ignored'] !== undefined))
      .toEqual([]);
  });

  it('says grants have no effect while delegated creation is off', () => {
    const off = render({ grants: [team], createEnabled: false });
    expect(off.renderer.root.findAll(node => node.props['data-bot-grants-inactive']).length).toBeGreaterThan(0);
    const on = render({ grants: [team], createEnabled: true });
    expect(on.renderer.root.findAll(node => node.props['data-bot-grants-inactive'])).toEqual([]);
  });
});

// The editor must refuse exactly what the server refuses: otherwise it either
// lets through a list the server bounces with a bare error code, or blocks one
// the server would have accepted.
describe('scheduleBotGrantDraftProblem', () => {
  it('agrees with the Dashboard write route', async () => {
    const cases: Array<[ScheduleBotGrant, ScheduleBotGrant[]]> = [
      [team, []],
      [{ ...team, id: 'bad id' }, []],
      [{ ...team, id: 'x'.repeat(65) }, []],
      [{ ...team, sourceAppId: '' }, []],
      [{ ...team, targetAppIds: [] }, []],
      [{ ...team, targetAppIds: ['not_an_app'] }, []],
      [{ ...team, chatIds: [] }, []],
      [{ ...team, chatIds: ['oc_team', 'chat'] }, []],
      [{ ...team, controllerUnionId: 'ou_admin' }, []],
      [{ ...team, id: 'two' }, [team]],
      [{ ...team, id: 'two', chatIds: ['oc_other'] }, [team]],
      [{ ...team, id: 'two', targetAppIds: ['cli_b'] }, [team]],
      [{ ...team, id: 'two', sourceAppId: 'cli_other' }, [team]],
      [{ ...team, sourceAppId: 'cli_other' }, [team]],
    ];
    for (const [grant, others] of cases) {
      const write = vi.fn();
      const result = await applySettingsWrite({ scheduleBotGrants: { grants: [...others, grant] } },
        { writeScheduleBotGrantConfig: write, resolveDashboardSettings: () => ({}) } as unknown as SettingsWriteApplierDeps);
      expect(scheduleBotGrantDraftProblem(grant, others) === null, JSON.stringify(grant)).toBe(result.ok);
    }
  });
});
