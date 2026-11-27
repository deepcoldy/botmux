import type { OncallFormDraft } from '../../services/oncall-form-store.js';
import { oncallRegionLabel } from '../../services/oncall-platform.js';
import { ONCALL_FIELD_LIMIT, oncallFieldName, oncallOptionValue } from '../../services/oncall-custom-form.js';
import { escapeLarkMd } from './dash-card-common.js';
import { buildOncallGroupColumn } from './oncall-card-actions.js';

// Leave room for the outbound callback stamp and request envelope, as other pickers do.
export const ONCALL_FORM_CARD_MAX_BYTES = 80_000;

export function buildOncallFormCard(draft: OncallFormDraft): string {
  const privateIntake = !!draft.source.privateIntake;
  const value = (action: string) => ({ action, draftId: draft.id, version: draft.version });
  const sidebar = (link: string) => draft.nativeSubmission?.attempts.find(item => item.sidebarLink?.href === link)?.sidebarLink?.hostedHref ?? link;
  if (draft.nativeEntry) return JSON.stringify({ schema: '2.0', config: { update_multi: true, width_mode: 'fill' },
    header: { title: { tag: 'plain_text', content: '发起人工 Oncall' }, template: 'blue' }, body: { elements: [
      ...(draft.description ? [{ tag: 'markdown', content: draft.description }] : []),
      { tag: 'markdown', content: `已选：${oncallRegionLabel(draft.region)} · ${draft.nativeEntry.categoryName} · ${draft.priority}\n${draft.nativeFormReason ?? '此分类需要补充信息，请在飞书侧栏填写表单并确认提单。'}\n${privateIntake ? '仅提交你在侧栏填写的内容。' : draft.nativeSubmission ? '提单成功后，原回答卡将显示进群入口，并按交接设置同步当前会话。' : '平台提单暂不自动关联人工群或转交当前对话。'}` },
      { tag: 'column_set', columns: [
        buildOncallGroupColumn({ href: sidebar(draft.nativeEntry.href), status: '填写人工 Oncall 表单' }),
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', type: 'default', size: 'small',
          text: { tag: 'plain_text', content: '收起入口' }, behaviors: [{ type: 'callback', value: value('oncall_group_form_cancel') }] }] },
      ] },
    ] } });
  const fields = draft.botmuxFields ?? [];
  const select = (name: string, label: string, choices: { value: string; label: string }[], selected?: string) => ({
    tag: 'select_static', width: 'fill', placeholder: { tag: 'plain_text', content: label },
    ...(selected ? { initial_option: selected } : {}),
    options: choices.map(item => ({ text: { tag: 'plain_text', content: item.label }, value: item.value })),
    behaviors: [{ type: 'callback', value: value(`oncall_group_form_${name}`) }],
  });
  const categories = draft.choices.regions[draft.region] ?? [];
  if (Object.keys(draft.choices.regions).length > 100 || categories.length > 100) throw new Error('当前分类数量超出卡片展示范围，请选择原生侧栏');
  const plainText = (content: string) => ({ tag: 'plain_text', content });
  const cancel = { tag: 'button', text: plainText('取消'), behaviors: [{ type: 'callback', value: value('oncall_group_form_cancel') }] };
  const actionRow = (primary: Record<string, unknown>, secondary: Record<string, unknown>) => ({
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'small',
    columns: [primary, secondary].map(button => ({ tag: 'column', width: 'auto', elements: [button] })),
  });
  const confirmText = plainText('确认发起人工 Oncall');
  // Keep selectors outside the form so their callbacks run before submission.
  const submission = fields.length ? [
    { tag: 'markdown', content: privateIntake ? '仅把这里填写的内容交给值班人员。切换分类会清空未提交内容。' : '更改上方选项后，需要重新填写附加信息。', text_size: 'notation' },
    { tag: 'form', name: `botmux_oncall_custom_form_${draft.version}`, elements: [
      ...fields.flatMap((field, index): Record<string, unknown>[] => field.type === 'radio' || field.type === 'select'
        ? [
          { tag: 'markdown', content: escapeLarkMd(field.label) + (field.required ? " <font color='red'>*</font>" : '') },
          { tag: 'select_static', name: oncallFieldName(index), required: field.required, width: 'fill',
            placeholder: plainText(field.requiredMessage ?? '请选择'), options: field.options!.map((option, optionIndex) => ({
              text: plainText(option.label), value: oncallOptionValue(optionIndex),
            })) },
        ] : [{
          tag: 'input', name: oncallFieldName(index), required: field.required, label: plainText(field.label), label_position: 'top',
          max_length: ONCALL_FIELD_LIMIT,
          ...(field.requiredMessage ? { placeholder: plainText(field.requiredMessage) } : {}),
          ...(field.type === 'textArea' ? { input_type: 'multiline_text', rows: 3, auto_resize: true, max_rows: 8 } : {}),
        }]),
      // Cancel has its own callback so only confirmation triggers native form validation.
      actionRow({ tag: 'button', name: 'botmux_oncall_submit', type: 'primary', text: confirmText,
        form_action_type: 'submit', behaviors: [{ type: 'callback', value: value('oncall_group_form_botmux_submit') }] },
        { tag: 'interactive_container', has_border: true, border_color: 'grey', corner_radius: '6px',
          padding: '4px 12px 4px 12px', behaviors: cancel.behaviors, elements: [{ tag: 'div', text: cancel.text }] }),
    ] },
  ] : [
    { tag: 'markdown', text_size: 'notation', content: draft.nativeFormLink
      ? [draft.nativeFormReason, privateIntake ? '请在侧栏填写要交给值班人员的信息并提交。' : '请在侧栏补充自定义信息并确认提单，成功后将按交接设置同步当前会话。'].filter(Boolean).join('\n')
      : privateIntake ? '仅创建人工群，私聊记录和附件不会自动转交。' : '建群后将按当前交接设置处理对话和附件。' },
    actionRow({ tag: 'button', text: confirmText, type: 'primary',
      disabled: !draft.region || !draft.typeId, behaviors: [draft.nativeFormLink
        ? { type: 'open_url', default_url: sidebar(draft.nativeFormLink) }
        : { type: 'callback', value: value('oncall_group_form_submit') }] }, cancel),
  ];
  const elements = [
      { tag: 'div', text: { tag: 'plain_text', content: privateIntake ? '请选择问题区域、分类和等级。' : draft.description || '使用当前问题的公开对话作为问题描述' } },
      { tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'default', columns: [
        select('region', '选择问题区域', Object.keys(draft.choices.regions).map(region => ({ value: region, label: oncallRegionLabel(region) })), draft.region),
        categories.length
          ? select('category', '选择问题分类', categories.map(category => ({ value: String(category.id), label: category.name })), draft.typeId ? String(draft.typeId) : undefined)
          : { tag: 'div', text: { tag: 'plain_text', content: draft.region ? '此区域暂无分类，请重新选择' : '请先选择问题区域' } },
        select('priority', '问题等级', [{ value: 'P2', label: 'P2 一般问题' },
          { value: 'P1', label: 'P1 阻塞离线业务／有潜在重大影响' }, { value: 'P0', label: 'P0 用户可感知／阻塞在线业务（谨慎选择）' }], draft.priority),
      ].map(element => ({ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [element] })) },
      ...submission,
    ];
  const header = { title: plainText('发起人工 Oncall'), template: 'blue' };
  return JSON.stringify({ schema: '2.0', config: { width_mode: 'fill', update_multi: draft.visibility === 'thread' }, header, body: { elements } });
}
