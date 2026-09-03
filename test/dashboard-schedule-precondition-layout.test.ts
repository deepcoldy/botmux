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

const BOTS = [{ larkAppId: 'cli_precondition_layout', botName: 'Precondition test bot' }];
const CHATS = [{
  chatId: 'oc_precondition_layout',
  name: 'Precondition test chat',
  memberBots: [{ larkAppId: 'cli_precondition_layout', inChat: true }],
}];
const EDITING = {
  id: 'schedule-precondition-layout-test',
  name: 'Precondition layout test',
  schedule: '0 9 * * *',
  prompt: 'A test-only prompt',
  larkAppId: 'cli_precondition_layout',
  chatIds: ['oc_precondition_layout'],
  hasPrecondition: true,
  preconditionEnabled: true,
  preconditionSource: 'inline' as const,
  preconditionScript: 'printf 1',
  workingDir: '/srv/botmux',
};
const tr = createDashboardTranslator('zh');

type FormProps = Parameters<typeof ScheduleFormModal>[0];

function savedPrecondition(source: 'inline' | 'file'): NonNullable<FormProps['editing']> {
  return source === 'inline' ? EDITING : {
    ...EDITING,
    preconditionSource: 'file',
    preconditionScript: undefined,
    preconditionFilePath: 'scripts/check-ready.sh',
  };
}

function textContent(node: TestRenderer.ReactTestInstance): string {
  return node.children.map(child => typeof child === 'string' ? child : textContent(child)).join('');
}

function dialogNode(onClose?: () => void) {
  const node = {
    open: false,
    showModal: vi.fn(() => { node.open = true; }),
    close: vi.fn(() => { node.open = false; onClose?.(); }),
    querySelector: vi.fn(() => ({ focus: vi.fn() })),
  };
  return node;
}

describe('schedule precondition compact editor', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.mocked(fetchGroupsSnapshot).mockResolvedValue({ bots: BOTS, chats: CHATS });
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function renderForm(editing: FormProps['editing'] = EDITING) {
    const onClose = vi.fn();
    const onSubmit = vi.fn();
    const formDialog = dialogNode();
    let helpDialog: ReturnType<typeof dialogNode> | undefined;
    const helpCloseNode = { focus: vi.fn() };

    await act(async () => {
      renderer = TestRenderer.create(createElement(ScheduleFormModal, {
        open: true,
        editing,
        error: null,
        bots: BOTS,
        scheduleTimeZone: 'Asia/Shanghai',
        tr,
        onClose,
        onSubmit,
      }), {
        createNodeMock(element) {
          if (element.props.className === 'schedule-form-dialog') return formDialog;
          if (element.props.id === 'schedule-precondition-help-dialog') {
            helpDialog = dialogNode(element.props.onClose);
            return helpDialog;
          }
          if (element.props.className === 'schedule-precondition-help-close') return helpCloseNode;
          return null;
        },
      });
    });

    const root = renderer!.root;
    const field = () => root.findByProps({ className: 'schedule-form-field schedule-precondition-field' });
    const toggle = () => field().findByProps({ role: 'switch' });
    const radio = (value: 'inline' | 'file' | 'keep') => field().findByProps({ name: 'preconditionSource', value });
    const inline = () => root.findByProps({ id: 'schedule-precondition-script' });
    const file = () => root.findByProps({ id: 'schedule-precondition-file-path' });
    const setEnabled = (checked: boolean) => act(() => toggle().props.onChange({ currentTarget: { checked } }));
    const setMode = (value: 'inline' | 'file') => act(() => radio(value).props.onChange());
    const setScript = (value: string) => act(() => inline().props.onChange({ target: { value } }));
    const setFile = (value: string) => act(() => file().props.onChange({ currentTarget: { value } }));
    const setSourceValue = (source: 'inline' | 'file', value: string) => source === 'inline' ? setScript(value) : setFile(value);
    const submit = () => act(() => root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }));
    const cancel = () => act(() => root.findByProps({ className: 'schedule-form-cancel' }).props.onClick());
    const fillNewRequiredFields = () => {
      act(() => {
        root.findByProps({ name: 'name' }).props.onChange({ target: { value: 'New test-only schedule' } });
        root.findByProps({ placeholder: tr('schedules.form.scheduleHelp') }).props.onChange({ target: { value: '0 9 * * *' } });
        root.findAllByType('textarea').find(node => node.props.required)!.props.onChange({ target: { value: 'Test-only prompt' } });
      });
      act(() => root.findByProps({ className: 'schedule-chat-picker-trigger' }).props.onClick());
      act(() => root.findAllByType('label')
        .find(node => String(node.props.title ?? '').includes('oc_precondition_layout'))!
        .findByType('input').props.onChange({ currentTarget: { checked: true } }));
      act(() => root.findByProps({ className: 'schedule-chat-picker-trigger' }).props.onClick());
    };
    return {
      root, field, toggle, radio, inline, file, setEnabled, setMode, setScript, setFile,
      setSourceValue, submit, cancel, fillNewRequiredFields,
      formDialog, helpDialog: helpDialog!, helpCloseNode, onClose, onSubmit,
    };
  }

  it('places the title and accessible switch in one compact header without a routine status row', async () => {
    const form = await renderForm();
    const header = form.field().findByProps({ className: 'schedule-precondition-header' });
    const title = header.findByProps({ id: 'schedule-precondition-label' });
    expect(textContent(title)).toContain(tr('schedules.form.precondition'));
    expect(header.findByProps({ role: 'switch' })).toBe(form.toggle());
    expect(form.toggle().props.type).toBe('checkbox');
    expect(form.toggle().props['aria-labelledby']).toContain('schedule-precondition-label');
    expect(form.toggle().props['aria-controls']).toBe('schedule-precondition-panel');
    expect(header.findAllByProps({ className: 'ui-info-tip' }).length).toBeGreaterThan(0);
    const toolbar = form.field().findByProps({ className: 'schedule-precondition-toolbar' });
    expect(toolbar.findByType('fieldset').props.className).toBe('schedule-precondition-source');
    expect(form.field().findAllByProps({ className: 'schedule-precondition-remove' })).toHaveLength(0);
    expect(form.field().findAllByProps({ type: 'checkbox' })).toEqual([form.toggle()]);
    expect(form.field().findAllByProps({ role: 'status' })).toHaveLength(0);
    expect(form.inline().props.rows).toBe(3);
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it.each([true, false])('keeps a saved script editable when toggling its initial enabled=%s state', async enabled => {
    const form = await renderForm({ ...EDITING, preconditionEnabled: enabled });
    expect(form.toggle().props.checked).toBe(enabled);
    expect(form.inline().props.value).toBe('printf 1');

    form.setEnabled(false);
    expect(form.toggle().props.checked).toBe(false);
    expect(form.inline().props.disabled).not.toBe(true);
    form.setScript('printf "ready"');
    expect(form.inline().props.value).toBe('printf "ready"');
    expect(form.field().findAllByProps({ role: 'status' })).toHaveLength(0);

    form.setEnabled(true);
    expect(form.toggle().props.checked).toBe(true);
    expect(form.inline().props.value).toBe('printf "ready"');
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it('keeps a new unsaved script draft across turning the precondition off and on', async () => {
    const form = await renderForm(null);
    expect(form.toggle().props.checked).toBe(false);
    expect(form.root.findAllByProps({ id: 'schedule-precondition-panel' })).toHaveLength(0);
    form.setEnabled(true);
    form.setScript('test -f .ready && printf 1');
    form.setEnabled(false);
    expect(form.root.findAllByProps({ id: 'schedule-precondition-panel' })).toHaveLength(0);
    form.setEnabled(true);
    expect(form.inline().props.value).toBe('test -f .ready && printf 1');
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it.each(['inline', 'file'] as const)('pauses a nonempty %s source only on save without removing it', async source => {
    const form = await renderForm(savedPrecondition(source));
    form.setEnabled(false);
    expect(form.onSubmit).not.toHaveBeenCalled();
    form.submit();
    expect(form.onSubmit).toHaveBeenCalledTimes(1);
    const submitted = form.onSubmit.mock.calls[0][0];
    expect(submitted.preconditionEnabled).toBe(false);
    expect(submitted).not.toHaveProperty('preconditionScript');
    expect(submitted).not.toHaveProperty('preconditionFilePath');
  });

  it('preserves independent inline and file drafts across source and enable changes', async () => {
    const form = await renderForm();
    form.setScript('printf "inline draft"');
    form.setMode('file');
    form.setFile('scripts/draft-ready.sh');
    expect(form.radio('file').props.checked).toBe(true);
    expect(form.radio('inline').props.checked).toBe(false);
    form.setMode('inline');
    expect(form.inline().props.value).toBe('printf "inline draft"');
    form.setEnabled(false);
    form.setMode('file');
    expect(form.file().props.value).toBe('scripts/draft-ready.sh');
    expect(form.file().props.disabled).not.toBe(true);
    form.setEnabled(true);
    form.setMode('inline');
    expect(form.inline().props.value).toBe('printf "inline draft"');
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['inline', 'file', 'schedules.form.preconditionFileHelpOpen', 'schedules.form.preconditionSourceFile'],
    ['file', 'inline', 'schedules.form.preconditionInlineHelpOpen', 'schedules.form.preconditionSourceInline'],
  ] as const)('while %s is selected, opens %s help without changing the selected radio or saving', async (selected, source, helpKey, titleKey) => {
    const form = await renderForm();
    form.setMode(selected);
    const helpButton = form.field().findByProps({ 'aria-label': tr(helpKey) });
    const returnFocusNode = { focus: vi.fn() };
    expect(helpButton.props.type).toBe('button');
    expect(helpButton.parent?.type).toBe('span');
    expect(helpButton.parent?.findAllByType('label')).toHaveLength(1);
    expect(helpButton.parent?.findByType('label').findAllByType('button')).toHaveLength(0);

    act(() => helpButton.props.onClick({ currentTarget: returnFocusNode }));
    expect(form.radio(selected).props.checked).toBe(true);
    expect(form.radio(source).props.checked).toBe(false);
    expect(helpButton.props['aria-expanded']).toBe(true);
    expect(form.helpDialog.open).toBe(true);
    expect(form.helpDialog.showModal).toHaveBeenCalledTimes(1);
    expect(form.helpCloseNode.focus).toHaveBeenCalledTimes(1);
    expect(textContent(form.root.findByProps({ id: 'schedule-precondition-source-help-title' }))).toBe(tr(titleKey));
    const sourceHelpText = textContent(form.root.findByProps({ className: 'schedule-precondition-source-help' }));
    expect(sourceHelpText.includes('请仅使用可信脚本')).toBe(source === 'file');
    expect(textContent(form.field())).not.toContain('请仅使用可信脚本');
    expect(form.root.findAllByProps({ className: 'schedule-precondition-help-view-only' })).toHaveLength(1);
    expect(form.onSubmit).not.toHaveBeenCalled();

    act(() => form.root.findByProps({ className: 'schedule-precondition-help-close' }).props.onClick());
    expect(form.helpDialog.open).toBe(false);
    expect(returnFocusNode.focus).toHaveBeenCalledTimes(1);
    expect(form.radio(selected).props.checked).toBe(true);
    expect(form.formDialog.open).toBe(true);
    expect(form.onClose).not.toHaveBeenCalled();
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    ['inline', '', true],
    ['inline', ' \n\t ', false],
    ['file', '', false],
    ['file', ' \n\t ', true],
  ] as const)('removes a saved %s source cleared to %j with enabled=%s only on save', async (source, value, enabled) => {
    const form = await renderForm({ ...savedPrecondition(source), preconditionEnabled: enabled });
    form.setSourceValue(source, value);
    expect(form.toggle().props.disabled).not.toBe(true);
    expect(form.root.findAllByProps({ id: 'schedule-precondition-panel' })).toHaveLength(1);
    expect(form.onSubmit).not.toHaveBeenCalled();
    form.submit();
    expect(form.onSubmit).toHaveBeenCalledTimes(1);
    const submitted = form.onSubmit.mock.calls[0][0];
    expect(submitted.preconditionScript).toBeNull();
    expect(submitted).not.toHaveProperty('preconditionFilePath');
    expect(submitted).not.toHaveProperty('preconditionEnabled');
  });

  it.each(['inline', 'file'] as const)('does not persist a cleared %s source when cancelling the form', async source => {
    const saved = savedPrecondition(source);
    const original = { ...saved };
    const form = await renderForm(saved);
    form.setSourceValue(source, ' \n\t ');
    expect(form.onSubmit).not.toHaveBeenCalled();
    form.cancel();
    expect(form.onClose).toHaveBeenCalledTimes(1);
    expect(form.onSubmit).not.toHaveBeenCalled();
    expect(saved).toEqual(original);
  });

  it('removes the blank selected source instead of restoring a nonempty hidden draft', async () => {
    const form = await renderForm();
    form.setScript('printf "hidden inline draft"');
    form.setMode('file');
    form.setFile(' \n\t ');
    form.submit();
    expect(form.onSubmit).toHaveBeenCalledTimes(1);
    expect(form.onSubmit.mock.calls[0][0].preconditionScript).toBeNull();
    expect(form.onSubmit.mock.calls[0][0]).not.toHaveProperty('preconditionFilePath');
  });

  it.each([
    ['inline', ''],
    ['inline', ' \n\t '],
    ['file', ''],
    ['file', ' \n\t '],
  ] as const)('creates no precondition when the new %s source is %j', async (source, value) => {
    const form = await renderForm(null);
    form.fillNewRequiredFields();
    form.setEnabled(true);
    form.setMode(source);
    form.setSourceValue(source, value);
    expect(form.onSubmit).not.toHaveBeenCalled();
    form.submit();
    expect(form.onSubmit).toHaveBeenCalledTimes(1);
    const submitted = form.onSubmit.mock.calls[0][0];
    expect(submitted).not.toHaveProperty('preconditionEnabled');
    expect(submitted).not.toHaveProperty('preconditionScript');
    expect(submitted).not.toHaveProperty('preconditionFilePath');
    expect(form.field().findAllByProps({ role: 'alert' })).toHaveLength(0);
  });

  it('preserves semantic source and editor labels while hiding only their repeated visual text', async () => {
    const form = await renderForm();
    const legend = form.field().findByType('legend');
    expect(legend.props.className).toBe('schedule-precondition-sr-only');
    expect(textContent(legend)).toBe(tr('schedules.form.preconditionSource'));
    expect(legend.props['aria-hidden']).not.toBe(true);
    const inlineLabel = form.field().findByProps({ htmlFor: 'schedule-precondition-script' });
    expect(inlineLabel.props.className).toBe('schedule-precondition-sr-only');
    expect(textContent(inlineLabel)).toBe(tr('schedules.form.preconditionInline'));
    expect(inlineLabel.props['aria-hidden']).not.toBe(true);
    expect(form.inline().props.id).toBe(inlineLabel.props.htmlFor);

    form.setMode('file');
    const fileLabel = form.field().findByProps({ htmlFor: 'schedule-precondition-file-path' });
    expect(fileLabel.props.className).toBe('schedule-precondition-sr-only');
    expect(textContent(fileLabel)).toBe(tr('schedules.form.preconditionFilePath'));
    expect(fileLabel.props['aria-hidden']).not.toBe(true);
    expect(form.file().props.id).toBe(fileLabel.props.htmlFor);
    expect(form.file().props.type).toBe('text');
    expect(form.onSubmit).not.toHaveBeenCalled();
  });

  it('retains the warning for an unreadable legacy precondition', async () => {
    const form = await renderForm({ ...EDITING, preconditionSource: undefined, preconditionScript: undefined });
    const status = form.field().findByProps({ role: 'status' });
    expect(textContent(status)).toBe(tr('schedules.form.preconditionUnavailableHelp'));
    expect(form.radio('keep').props.checked).toBe(true);
    form.setEnabled(false);
    expect(textContent(form.field().findByProps({ role: 'status' }))).toBe(tr('schedules.form.preconditionUnavailableHelp'));
    expect(form.radio('keep').props.checked).toBe(true);
    expect(form.onSubmit).not.toHaveBeenCalled();
  });
});
