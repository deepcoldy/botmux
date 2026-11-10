import type { OncallFormDraft } from '../../services/oncall-form-store.js';

export function buildOncallFormCard(draft: OncallFormDraft): string {
  const value = (action: string) => ({ action, draftId: draft.id, version: draft.version });
  const select = (name: string, label: string, choices: { value: string; label: string }[], selected?: string) => ({
    tag: 'select_static', width: 'fill', placeholder: { tag: 'plain_text', content: label },
    ...(selected ? { initial_option: selected } : {}),
    options: choices.map(item => ({ text: { tag: 'plain_text', content: item.label }, value: item.value })),
    value: value(`oncall_group_form_${name}`),
  });
  const categories = draft.choices.regions[draft.region] ?? [];
  if (Object.keys(draft.choices.regions).length > 100 || categories.length > 100) throw new Error('当前分类数量超出卡片展示范围，请选择原生侧栏');
  return JSON.stringify({ config: { wide_screen_mode: true, update_multi: draft.visibility === 'thread' },
    header: { title: { tag: 'plain_text', content: '发起人工 Oncall' }, template: 'blue' }, elements: [
      { tag: 'div', text: { tag: 'plain_text', content: draft.description || '使用当前问题的公开对话作为问题描述' } },
      { tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'default', columns: [
        select('region', '选择问题区域', Object.keys(draft.choices.regions).map(region => ({ value: region, label: region })), draft.region),
        categories.length
          ? select('category', '选择问题分类', categories.map(category => ({ value: String(category.id), label: category.name })), draft.typeId ? String(draft.typeId) : undefined)
          : { tag: 'div', text: { tag: 'plain_text', content: draft.region ? '此区域暂无分类，请重新选择' : '请先选择问题区域' } },
        select('priority', '问题等级', [{ value: 'P2', label: 'P2 一般问题，如咨询等' },
          { value: 'P1', label: 'P1 阻塞离线业务／有潜在重大影响' }, { value: 'P0', label: 'P0 用户可感知／阻塞在线业务（谨慎选择）' }], draft.priority),
      ].map(element => ({ tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [element] })) },
      { tag: 'note', elements: [{ tag: 'plain_text', content: '将同步本问题的对话及附件。' }] },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '确认发起人工 Oncall' }, type: 'primary',
          disabled: !draft.region || !draft.typeId, value: value('oncall_group_form_submit') },
        { tag: 'button', text: { tag: 'plain_text', content: '取消' }, value: value('oncall_group_form_cancel') },
      ] },
    ] });
}
