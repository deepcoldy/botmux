export function buildOncallGroupColumn(options: { href?: string; status?: string; joinGroup?: boolean; disabled?: boolean; retryForward?: boolean; handoffStatus?: string; confirmText?: string } = {}): Record<string, any> {
  return { tag: 'column', element_id: 'botmux_oncall_group_column', width: 'auto', direction: 'horizontal',
    horizontal_spacing: '8px', vertical_align: 'center', padding: '0px', elements: [{
      tag: 'button', text: { tag: 'plain_text', content: options.status ?? '转人工' }, type: 'default', size: 'small',
      ...((options.href || options.joinGroup) && options.status ? { icon: { tag: 'standard_icon', token: 'chat_outlined', color: 'grey' } } : {}),
      ...(options.disabled ? { disabled: true } : {}),
      ...(options.confirmText ? { confirm: { title: { tag: 'plain_text', content: '确认发起人工 Oncall？' }, text: { tag: 'plain_text', content: options.confirmText } } } : {}),
      behaviors: options.href ? [{ type: 'open_url', default_url: options.href }]
        : [{ type: 'callback', value: { action: options.joinGroup ? 'oncall_group_join' : 'oncall_group_create' } }],
    }, ...(options.handoffStatus ? [{ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${options.handoffStatus}</font>` }] : []),
    ...(options.retryForward ? [{ tag: 'button', type: 'default', size: 'small', text: { tag: 'plain_text', content: '重试转交' },
      behaviors: [{ type: 'callback', value: { action: 'oncall_group_forward' } }] }] : [])] };
}
