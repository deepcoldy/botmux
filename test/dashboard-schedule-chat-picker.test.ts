import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGroupsSnapshot } from '../src/dashboard/web/groups-api.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { ScheduleFormModal } from '../src/dashboard/web/schedules-page.js';

vi.mock('../src/dashboard/web/groups-api.js', () => ({
  fetchGroupsSnapshot: vi.fn(),
  fetchGroupsNamesSnapshot: vi.fn(),
}));

const BOTS = [{ larkAppId: 'cli_picker', botName: 'Picker bot' }];
const CHATS = [
  { chatId: 'oc_alpha', name: 'Alpha', memberBots: [{ larkAppId: 'cli_picker', inChat: true }] },
  { chatId: 'oc_beta', name: 'Beta', memberBots: [{ larkAppId: 'cli_picker', inChat: true }] },
];
const EDITING = {
  id: 'schedule-picker-test',
  name: 'Picker test',
  schedule: '0 9 * * *',
  prompt: 'A test-only prompt',
  larkAppId: 'cli_picker',
  chatIds: ['oc_alpha'],
};

type FormProps = Parameters<typeof ScheduleFormModal>[0];

function documentListeners() {
  const listeners = new Map<string, Set<EventListener>>();
  return {
    addEventListener: vi.fn((type: string, listener: EventListener, _capture?: boolean) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListener, _capture?: boolean) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(event: Event) {
      act(() => {
        for (const listener of [...listeners.get(event.type) ?? []]) listener(event);
      });
    },
    count(type: string) { return listeners.get(type)?.size ?? 0; },
  };
}

function pointerDown(target: object): Event {
  const event = new Event('pointerdown');
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

function keyDown(key: string): Event {
  const event = new Event('keydown', { cancelable: true });
  Object.defineProperty(event, 'key', { value: key });
  return event;
}

describe('schedule form chat picker', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let documentMock: ReturnType<typeof documentListeners>;

  beforeEach(() => {
    documentMock = documentListeners();
    vi.stubGlobal('document', documentMock);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.mocked(fetchGroupsSnapshot).mockResolvedValue({ bots: BOTS, chats: CHATS });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderForm(editing: FormProps['editing'] = null) {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const triggerNode = { focus: vi.fn() };
    const searchNode = { focus: vi.fn() };
    const insideTarget = {};
    const insideTargets = new Set<unknown>([triggerNode, searchNode, insideTarget]);
    const pickerNode = { contains: vi.fn((target: unknown) => insideTargets.has(target)) };
    insideTargets.add(pickerNode);
    const dialogNode = {
      open: false,
      showModal: vi.fn(() => { dialogNode.open = true; }),
      close: vi.fn(() => { dialogNode.open = false; }),
      querySelector: vi.fn(() => ({ focus: vi.fn() })),
    };
    const props: FormProps = {
      open: true,
      editing,
      error: null,
      bots: BOTS,
      scheduleTimeZone: 'Asia/Shanghai',
      tr: createDashboardTranslator('zh'),
      onClose,
      onSubmit,
    };

    await act(async () => {
      renderer = TestRenderer.create(createElement(ScheduleFormModal, props), {
        createNodeMock(element) {
          if (element.props.className === 'schedule-form-dialog') return dialogNode;
          if (element.props.className === 'schedule-chat-picker') return pickerNode;
          if (element.props.className === 'schedule-chat-picker-trigger') return triggerNode;
          if (element.props.className === 'schedule-chat-search') return searchNode;
          return null;
        },
      });
    });

    const root = renderer!.root;
    const trigger = () => root.findByProps({ className: 'schedule-chat-picker-trigger' });
    const search = () => root.findByProps({ className: 'schedule-chat-search' });
    const panel = () => root.findAllByProps({ className: 'schedule-chat-picker-panel' });
    const checkbox = (chatId: string) => root.findAllByType('label')
      .find(node => String(node.props.title ?? '').includes(chatId))?.findByType('input');
    const toggle = () => act(() => trigger().props.onClick());
    const updateOpen = (open: boolean) => act(() => {
      renderer!.update(createElement(ScheduleFormModal, { ...props, open }));
    });
    return { root, trigger, search, panel, checkbox, toggle, updateOpen, pickerNode, triggerNode, searchNode, insideTarget, dialogNode, onClose, onSubmit };
  }

  function expectNoManualEntry(root: TestRenderer.ReactTestInstance): void {
    expect(root.findAllByProps({ className: 'schedule-chat-manual-input' })).toHaveLength(0);
    expect(root.findAllByType('button').filter(button => button.children.includes('手动输入群聊 ID')))
      .toHaveLength(0);
  }

  it.each([
    ['create', null],
    ['edit', EDITING],
  ] as const)('starts collapsed in the %s form and shows the current selection summary', async (_mode, editing) => {
    const form = await renderForm(editing);

    expect(fetchGroupsSnapshot).toHaveBeenCalledWith({ cacheMs: 30_000 });
    expect(form.trigger().props.type).toBe('button');
    expect(form.trigger().props['aria-expanded']).toBe(false);
    expect(form.panel()).toHaveLength(0);
    expect(form.root.findAllByProps({ className: 'schedule-chat-search' })).toHaveLength(0);
    expect(form.root.findAllByProps({ className: 'schedule-chat-selector' })).toHaveLength(0);
    expect(form.root.findByProps({ className: 'schedule-chat-picker-summary' }).children)
      .toEqual([editing ? 'Alpha' : '选择群聊']);
    if (editing) expect(form.trigger().findByType('small').children).toEqual(['已选择 1 个群']);
    expect(documentMock.addEventListener).not.toHaveBeenCalled();
    expect(form.onSubmit).not.toHaveBeenCalled();
    expectNoManualEntry(form.root);
  });

  it('searches by group ID in the same selector without requiring a manual-entry mode', async () => {
    const form = await renderForm();
    form.toggle();
    act(() => form.search().props.onChange({ currentTarget: { value: '  OC_BETA  ' } }));
    expect(form.checkbox('oc_alpha')).toBeUndefined();
    expect(form.checkbox('oc_beta')).toBeDefined();
    act(() => form.checkbox('oc_beta')!.props.onChange({ currentTarget: { checked: true } }));
    expect(form.checkbox('oc_beta')!.props.checked).toBe(true);
    expect(form.trigger().props.title).toBe('Beta');
    expectNoManualEntry(form.root);
  });

  it.each<[string, Awaited<ReturnType<typeof fetchGroupsSnapshot>>['chats']]>([
    ['empty roster', []],
    ['no joined groups', [{
      chatId: 'oc_not_joined',
      name: 'Not joined',
      memberBots: [{ larkAppId: 'cli_picker', inChat: false }],
    }]],
  ])('keeps the dropdown available with an empty-state message for %s', async (_case, chats) => {
    vi.mocked(fetchGroupsSnapshot).mockResolvedValueOnce({ bots: BOTS, chats });
    const form = await renderForm();
    expect(form.trigger().props['aria-expanded']).toBe(false);
    expectNoManualEntry(form.root);
    form.toggle();
    expect(form.search()).toBeDefined();
    expect(form.panel()[0].findByProps({ className: 'schedule-chat-selector-empty' }).children)
      .toEqual(['该 Bot 暂无可选择的已加入群聊。']);
    expect(form.panel()[0].findAllByType('input').filter(input => input.props.type === 'checkbox'))
      .toHaveLength(0);
    expectNoManualEntry(form.root);
  });

  it('shows loading inside the dropdown and then replaces it with the loaded groups', async () => {
    let resolveGroups!: (snapshot: Awaited<ReturnType<typeof fetchGroupsSnapshot>>) => void;
    vi.mocked(fetchGroupsSnapshot).mockReturnValueOnce(new Promise(resolve => { resolveGroups = resolve; }));
    const form = await renderForm();
    expect(form.trigger().props['aria-expanded']).toBe(false);
    form.toggle();
    expect(form.panel()[0].findByProps({ role: 'status' }).children)
      .toEqual([createDashboardTranslator('zh')('common.loading')]);
    expect(form.panel()[0].findAllByProps({ className: 'schedule-chat-selector-empty' })).toHaveLength(0);
    expectNoManualEntry(form.root);

    await act(async () => resolveGroups({ bots: BOTS, chats: CHATS }));
    expect(form.panel()[0].findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(form.checkbox('oc_alpha')).toBeDefined();
    expect(form.checkbox('oc_beta')).toBeDefined();
    expectNoManualEntry(form.root);
  });

  it('shows a group-loading error in the dropdown instead of falling back to manual input', async () => {
    vi.mocked(fetchGroupsSnapshot).mockRejectedValueOnce(new Error('roster unavailable'));
    const form = await renderForm();
    form.toggle();
    expect(form.panel()[0].findByProps({ role: 'alert' }).children)
      .toEqual(['无法加载群列表，请关闭编辑窗口后重试。']);
    expect(form.panel()[0].findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(form.panel()[0].findAllByProps({ className: 'schedule-chat-selector-empty' })).toHaveLength(0);
    expectNoManualEntry(form.root);
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it.each(['missing from the roster', 'unavailable because the roster failed'])(
    'preserves and submits a historical target %s', async missingReason => {
      if (missingReason === 'unavailable because the roster failed') {
        vi.mocked(fetchGroupsSnapshot).mockRejectedValueOnce(new Error('roster unavailable'));
      }
      const form = await renderForm({ ...EDITING, chatIds: ['oc_retained'] });
      expect(form.trigger().props.title).toBe('oc_retained');
      form.toggle();
      expect(form.checkbox('oc_retained')!.props.checked).toBe(true);
      expect(form.root.findByProps({ className: 'schedule-chat-option is-retained' })).toBeDefined();
      act(() => form.search().props.onChange({ currentTarget: { value: 'oc_retained' } }));
      expect(form.checkbox('oc_retained')!.props.checked).toBe(true);
      expectNoManualEntry(form.root);
      act(() => form.root.findByType('form').props.onSubmit({ preventDefault() {} }));
      expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({ chatIds: ['oc_retained'] }));
    },
  );

  it('keeps the picker open and preserves selections hidden by a later search', async () => {
    const form = await renderForm();
    form.toggle();

    expect(form.trigger().props['aria-expanded']).toBe(true);
    expect(form.panel()[0].props.id).toBe(form.trigger().props['aria-controls']);
    expect(form.searchNode.focus).toHaveBeenCalledTimes(1);
    act(() => form.checkbox('oc_alpha')!.props.onChange({ currentTarget: { checked: true } }));
    expect(form.panel()).toHaveLength(1);

    act(() => form.search().props.onChange({ currentTarget: { value: 'Beta' } }));
    expect(form.checkbox('oc_alpha')).toBeUndefined();
    act(() => form.checkbox('oc_beta')!.props.onChange({ currentTarget: { checked: true } }));
    expect(form.panel()).toHaveLength(1);

    act(() => form.search().props.onChange({ currentTarget: { value: '' } }));
    expect(form.checkbox('oc_alpha')!.props.checked).toBe(true);
    expect(form.checkbox('oc_beta')!.props.checked).toBe(true);
    form.toggle();
    expect(form.panel()).toHaveLength(0);
    expect(form.trigger().props.title).toBe('Alpha\nBeta');
    expect(form.trigger().findByType('small').children).toEqual(['已选择 2 个群']);
    form.toggle();
    expect(form.checkbox('oc_alpha')!.props.checked).toBe(true);
    expect(form.checkbox('oc_beta')!.props.checked).toBe(true);
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it('preserves single-chat replacement when editing an existing topic', async () => {
    const form = await renderForm({ ...EDITING, executionPosition: 'topic', rootMessageId: 'om_existing' });
    form.toggle();
    expect(form.checkbox('oc_alpha')!.props.checked).toBe(true);
    act(() => form.checkbox('oc_beta')!.props.onChange({ currentTarget: { checked: true } }));
    expect(form.panel()).toHaveLength(1);
    expect(form.checkbox('oc_alpha')!.props.checked).toBe(false);
    expect(form.checkbox('oc_beta')!.props.checked).toBe(true);
    form.toggle();
    expect(form.trigger().props.title).toBe('Beta');
    expect(form.trigger().findByType('small').children).toEqual(['已选择 1 个群']);
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it('ignores pointerdown inside the picker and closes on an outside pointerdown', async () => {
    const form = await renderForm();
    form.toggle();
    expect(documentMock.addEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentMock.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);

    documentMock.dispatch(pointerDown(form.insideTarget));
    expect(form.panel()).toHaveLength(1);
    documentMock.dispatch(pointerDown({}));
    expect(form.panel()).toHaveLength(0);
    expect(form.trigger().props['aria-expanded']).toBe(false);
    expect(documentMock.count('pointerdown')).toBe(0);
    expect(documentMock.count('keydown')).toBe(0);
    expect(form.onClose).not.toHaveBeenCalled();
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it('consumes Escape and restores trigger focus without closing the parent dialog', async () => {
    const form = await renderForm(EDITING);
    form.toggle();
    documentMock.dispatch(keyDown('ArrowDown'));
    expect(form.panel()).toHaveLength(1);

    const escape = keyDown('Escape');
    const stopPropagation = vi.spyOn(escape, 'stopPropagation');
    documentMock.dispatch(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(form.panel()).toHaveLength(0);
    expect(form.triggerNode.focus).toHaveBeenCalledTimes(1);
    expect(form.dialogNode.open).toBe(true);
    expect(form.dialogNode.close).not.toHaveBeenCalled();
    expect(form.onClose).not.toHaveBeenCalled();
    expect(documentMock.count('keydown')).toBe(0);
  });

  it('prevents Enter in search from submitting the form without swallowing other keys', async () => {
    const form = await renderForm(EDITING);
    form.toggle();
    const enter = keyDown('Enter');
    act(() => form.search().props.onKeyDown(enter));
    expect(enter.defaultPrevented).toBe(true);
    expect(form.onSubmit).not.toHaveBeenCalled();
    expect(form.panel()).toHaveLength(1);

    const letter = keyDown('a');
    act(() => form.search().props.onKeyDown(letter));
    expect(letter.defaultPrevented).toBe(false);
  });

  it('stays open when focus moves inside and closes when focus leaves the picker', async () => {
    const form = await renderForm();
    form.toggle();
    const picker = form.root.findByProps({ className: 'schedule-chat-picker' });
    act(() => picker.props.onBlur({ currentTarget: form.pickerNode, relatedTarget: form.insideTarget }));
    expect(form.panel()).toHaveLength(1);
    act(() => picker.props.onBlur({ currentTarget: form.pickerNode, relatedTarget: {} }));
    expect(form.panel()).toHaveLength(0);
    expect(form.onClose).not.toHaveBeenCalled();
  });

  it('removes the document listeners when an open picker unmounts', async () => {
    const form = await renderForm();
    form.toggle();
    expect(documentMock.count('pointerdown')).toBe(1);
    expect(documentMock.count('keydown')).toBe(1);
    act(() => renderer!.unmount());
    renderer = undefined;
    expect(documentMock.count('pointerdown')).toBe(0);
    expect(documentMock.count('keydown')).toBe(0);
    expect(documentMock.removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(documentMock.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
  });

  it('stops intercepting document events when the parent form closes without unmounting', async () => {
    const form = await renderForm();
    form.toggle();
    expect(documentMock.count('pointerdown')).toBe(1);
    expect(documentMock.count('keydown')).toBe(1);
    form.updateOpen(false);
    expect(form.dialogNode.close).toHaveBeenCalledTimes(1);
    expect(documentMock.count('pointerdown')).toBe(0);
    expect(documentMock.count('keydown')).toBe(0);
    const escape = keyDown('Escape');
    documentMock.dispatch(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(form.triggerNode.focus).not.toHaveBeenCalled();
  });
});
