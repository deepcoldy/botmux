import { describe, expect, it } from 'vitest';
import {
  buildVcMeetingConsumerCard,
  buildVcMeetingConsumerRecoveryCard,
} from '../src/vc-agent/cards.js';

describe('VC meeting consumer card builder', () => {
  it('renders a signed active-recovery choice without a silent default', () => {
    const card = JSON.parse(buildVcMeetingConsumerRecoveryCard({
      status: 'pending',
      meeting: { id: 'm_recovery', topic: 'Recovery' },
      nonce: 'nonce_recovery',
      memberEpoch: 3,
      missingItemVersionKey: 'chat:missing:r1',
      error: '事件源仍不可用',
    })) as any;
    const actions = card.elements.find((element: any) => element.tag === 'action').actions;

    expect(card.header.title.content).toBe('会议 agent 恢复需要处理');
    expect(card.elements[0].content).toContain('事件源仍不可用');
    expect(actions.map((button: any) => button.value)).toEqual([
      {
        action: 'vc_meeting_consumer_recovery',
        decision: 'retry',
        meeting_id: 'm_recovery',
        nonce: 'nonce_recovery',
      },
      {
        action: 'vc_meeting_consumer_recovery',
        decision: 'abandon_from_now',
        meeting_id: 'm_recovery',
        nonce: 'nonce_recovery',
      },
    ]);
  });

  it('binds a profile recovery choice to its exact member stream', () => {
    const card = JSON.parse(buildVcMeetingConsumerRecoveryCard({
      status: 'pending',
      meeting: { id: 'm_profiles' },
      nonce: 'nonce_profile',
      memberEpoch: 2,
      memberId: 'minutes_profile',
      memberLabel: 'Minutes',
    })) as any;
    const actions = card.elements.find((element: any) => element.tag === 'action').actions;

    expect(card.elements[0].content).toContain('Minutes');
    expect(actions.map((button: any) => button.value.member_id)).toEqual([
      'minutes_profile',
      'minutes_profile',
    ]);
  });

  it('keeps the legacy single-agent pending card DOM unchanged', () => {
    const card = JSON.parse(buildVcMeetingConsumerCard({
      status: 'pending',
      meeting: { id: 'm1', meetingNo: '123', topic: 'Weekly' },
      nonce: 'n1',
      candidates: [{ larkAppId: 'cli_a', label: 'Claude' }],
      defaultMode: 'agent',
      defaultAgentAppId: 'cli_a',
      syncIntervalMs: 30_000,
      stagedMode: 'agent',
      stagedAgentAppId: 'cli_a',
      stagedAgentLabel: 'Claude',
    }));

    expect(card).toEqual({
      schema: '2.0',
      config: { update_multi: true, width_mode: 'default' },
      header: {
        title: { tag: 'plain_text', content: '会议处理方式' },
        template: 'blue',
      },
      body: {
        direction: 'vertical',
        padding: '12px 12px 16px 12px',
        vertical_spacing: 'medium',
        elements: [
          {
            tag: 'markdown',
            content: [
              '选择处理方式和同步间隔后点击"确认"生效；完全不操作会按默认设置执行。',
              '',
              '**会议**：Weekly',
              '**会议号**：123',
              '**meeting.id**：`m1`',
              '**默认**：Claude',
              '**同步间隔**：30 秒',
              '**自定义间隔**：可填写 10-3600 秒，点击"确认"时会覆盖预设。',
              '**当前选择**：Claude（待确认）',
            ].join('\n'),
          },
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '选择 agent' },
            width: 'fill',
            initial_option: 'cli_a',
            behaviors: [{
              type: 'callback',
              value: {
                action: 'vc_meeting_consumer_stage',
                stage_kind: 'agent',
                meeting_id: 'm1',
                nonce: 'n1',
              },
            }],
            options: [{
              text: { tag: 'plain_text', content: 'Claude' },
              value: 'cli_a',
            }],
          },
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '同步间隔' },
            width: 'fill',
            initial_option: '30000',
            behaviors: [{
              type: 'callback',
              value: {
                action: 'vc_meeting_consumer_stage',
                stage_kind: 'interval',
                meeting_id: 'm1',
                nonce: 'n1',
              },
            }],
            options: [
              { text: { tag: 'plain_text', content: '15 秒' }, value: '15000' },
              { text: { tag: 'plain_text', content: '30 秒' }, value: '30000' },
              { text: { tag: 'plain_text', content: '60 秒' }, value: '60000' },
              { text: { tag: 'plain_text', content: '90 秒' }, value: '90000' },
            ],
          },
          {
            tag: 'form',
            name: 'vc_meeting_consumer_confirm_form',
            elements: [
              {
                tag: 'input',
                name: 'vc_meeting_custom_interval_seconds',
                label: { tag: 'plain_text', content: '自定义同步间隔（秒）' },
                placeholder: { tag: 'plain_text', content: '例如 45，范围 10-3600' },
                default_value: '',
              },
              {
                tag: 'button',
                name: 'vc_meeting_consumer_confirm_submit',
                text: { tag: 'plain_text', content: '确认' },
                type: 'primary_filled',
                width: 'fill',
                action_type: 'form_submit',
                value: {
                  action: 'vc_meeting_consumer_confirm',
                  meeting_id: 'm1',
                  nonce: 'n1',
                },
              },
            ],
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '只监听消息' },
            type: 'default',
            behaviors: [{
              type: 'callback',
              value: {
                action: 'vc_meeting_consumer_stage',
                stage_kind: 'listenOnly',
                meeting_id: 'm1',
                nonce: 'n1',
              },
            }],
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '使用默认设置' },
            type: 'default',
            behaviors: [{
              type: 'callback',
              value: {
                action: 'vc_meeting_consumer_select',
                consumer_mode: 'default',
                meeting_id: 'm1',
                nonce: 'n1',
              },
            }],
          },
        ],
      },
    });
  });

  it('renders the profile pending card as toggle grid + expanded panel + root form', () => {
    const json = buildVcMeetingConsumerCard({
      selectionMode: 'profiles',
      status: 'pending',
      meeting: { id: 'm_profiles', topic: 'Planning' },
      nonce: 'nonce_profiles',
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes', 'speaker'],
      stagedSelectedProfileIds: ['minutes'],
      syncIntervalMs: 60_000,
      profiles: [
        {
          id: 'minutes',
          agentAppId: 'cli_minutes',
          agentLabel: 'meeting-notes-bot',
          label: '纪要',
          role: 'minutes',
          responseMode: 'silent',
          capabilities: ['meeting.read'],
          activationStatus: 'activating',
        },
        {
          id: 'speaker',
          agentAppId: 'cli_speaker',
          agentLabel: 'action-items-bot',
          label: '发言',
          role: 'speaker',
          responseMode: 'silent',
          capabilities: ['meeting.read', 'meeting.output.request'],
          ownedSinks: ['meeting_text', 'meeting_voice'],
          activationStatus: 'active',
        },
        {
          id: 'risk',
          agentAppId: 'cli_risk',
          label: '风险',
          role: 'risk',
          responseMode: 'listener_thread',
          capabilities: ['meeting.read'],
          activationStatus: 'failed',
          activationError: 'daemon offline',
        },
      ],
    });
    const card = JSON.parse(json) as any;
    const elements = card.body.elements as any[];
    const buttons = collectButtons(elements);
    const actionValue = (element: any) => element.behaviors?.find((b: any) => b?.type === 'callback')?.value;
    const toggles = buttons.filter(button => actionValue(button)?.action === 'vc_meeting_consumer_profile_toggle');

    expect(json).not.toContain('multi_select_static');

    // toggle 网格：每行 column_set ≤ 2 列，按钮进列而非全宽堆叠
    const rows = elements.filter(element => element.tag === 'column_set');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.flex_mode).toBe('bisect');
      expect(row.columns.length).toBeLessThanOrEqual(2);
    }

    // 预设 toggle：☑/☐ + 名字 + agent 真名；选中态 primary（描边），非 filled
    expect(toggles).toHaveLength(3);
    expect(toggles[0].text.content).toBe('☑ 纪要 · meeting-notes-bot');
    expect(toggles[0].type).toBe('primary');
    expect(actionValue(toggles[0])).toEqual({
      action: 'vc_meeting_consumer_profile_toggle',
      meeting_id: 'm_profiles',
      profile_id: 'minutes',
      operation: 'deselect',
      selected: false,
      nonce: 'nonce_profiles',
    });
    expect(toggles[1].text.content).toBe('☐ 发言 · action-items-bot');
    expect(toggles[1]).toMatchObject({
      type: 'default',
      behaviors: [{
        value: {
          profile_id: 'speaker',
          operation: 'select',
          selected: true,
        },
      }],
    });
    // agentLabel 缺省回退 agentAppId
    expect(toggles[2].text.content).toBe('☐ 风险 · cli_risk');

    // 只监听是网格内的对等选项；有暂存非空选择时不高亮
    const clear = buttons.find(button => actionValue(button)?.action === 'vc_meeting_consumer_profile_clear');
    expect(clear.text.content).toBe('☐ 只监听（不启用 agent）');
    expect(clear.type).toBe('default');
    expect(actionValue(clear)).toEqual({
      action: 'vc_meeting_consumer_profile_clear',
      operation: 'clear',
      meeting_id: 'm_profiles',
      nonce: 'nonce_profiles',
    });

    // 详情面板：默认展开、包含详情与间隔 select、绝不内嵌 form
    const panel = elements.find(element => element.tag === 'collapsible_panel');
    expect(panel.expanded).toBe(true);
    expect(JSON.stringify(panel)).not.toContain('"form"');
    const panelMarkdown = panel.elements
      .filter((element: any) => element.tag === 'markdown')
      .map((element: any) => element.content)
      .join('\n');
    expect(panelMarkdown).toContain('agent：meeting-notes-bot · 角色：`minutes` · 回复：静默 · 受管输出：无');
    expect(panelMarkdown).toContain('会中文字、会议语音');
    expect(panelMarkdown).toContain('状态：启用中');
    expect(panelMarkdown).toContain('状态：已启用');
    expect(panelMarkdown).toContain('状态：启用失败：daemon offline');
    expect(panelMarkdown).toContain('回复：监听群回复');
    const intervalSelect = panel.elements.find((element: any) => element.tag === 'select_static');
    expect(actionValue(intervalSelect)).toEqual({
      action: 'vc_meeting_consumer_stage',
      stage_kind: 'interval',
      meeting_id: 'm_profiles',
      nonce: 'nonce_profiles',
    });

    // 根级 form：input + form_submit 确认（唯一 primary_filled）；form 内无 select
    const form = elements.find(element => element.tag === 'form');
    expect(form.name).toBe('vc_meeting_consumer_confirm_form');
    expect(form.elements.some((element: any) => element.tag === 'select_static')).toBe(false);
    expect(form.elements.find((element: any) => element.tag === 'input').name)
      .toBe('vc_meeting_custom_interval_seconds');
    const confirm = form.elements.find((element: any) => element.name === 'vc_meeting_consumer_confirm_submit');
    expect(confirm.action_type).toBe('form_submit');
    expect(confirm.value).toEqual({
      action: 'vc_meeting_consumer_confirm',
      consumer_mode: 'profiles',
      meeting_id: 'm_profiles',
      nonce: 'nonce_profiles',
    });
    expect(buttons.filter(button => button.type === 'primary_filled')).toEqual([confirm]);

    // 恢复默认选择：根级按钮，payload 不变
    const restoreDefault = buttons.find(button => actionValue(button)?.action === 'vc_meeting_consumer_profile_default');
    expect(restoreDefault.text.content).toBe('恢复默认选择');
    expect(actionValue(restoreDefault)).toEqual({
      action: 'vc_meeting_consumer_profile_default',
      operation: 'use_default',
      meeting_id: 'm_profiles',
      nonce: 'nonce_profiles',
    });
  });

  it('wraps an odd toggle count into bisect rows with a short tail row', () => {
    const card = JSON.parse(buildVcMeetingConsumerCard({
      selectionMode: 'profiles',
      status: 'pending',
      meeting: { id: 'm_odd' },
      nonce: 'nonce_odd',
      defaultMode: 'agents',
      defaultConsumerIds: ['a'],
      profiles: [
        { id: 'a', agentAppId: 'cli_a', label: 'A', role: 'a', responseMode: 'silent', capabilities: ['meeting.read'] },
        { id: 'b', agentAppId: 'cli_b', label: 'B', role: 'b', responseMode: 'silent', capabilities: ['meeting.read'] },
      ],
    })) as any;
    // 2 预设 + 只监听 = 3 个 toggle → [2, 1] 两行，均为 bisect
    const rows = (card.body.elements as any[]).filter(element => element.tag === 'column_set');
    expect(rows.map((row: any) => row.columns.length)).toEqual([2, 1]);
    for (const row of rows) expect(row.flex_mode).toBe('bisect');
  });

  it('keeps the agent suffix visible when the profile label is oversized', () => {
    const longLabel = '一个非常非常非常非常非常非常非常非常非常非常非常长的预设名称超出预算';
    const card = JSON.parse(buildVcMeetingConsumerCard({
      selectionMode: 'profiles',
      status: 'pending',
      meeting: { id: 'm_long' },
      nonce: 'nonce_long',
      defaultMode: 'agents',
      defaultConsumerIds: ['long'],
      profiles: [{
        id: 'long',
        agentAppId: 'cli_long',
        agentLabel: 'meeting-notes-bot',
        label: longLabel,
        role: 'minutes',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
      }],
    })) as any;
    const buttons = collectButtons(card.body.elements);
    const actionValue = (element: any) => element.behaviors?.find((b: any) => b?.type === 'callback')?.value;
    const toggle = buttons.find(button => actionValue(button)?.action === 'vc_meeting_consumer_profile_toggle');

    // profile 名截断加省略号，但「· agent 名」后缀必须完整保留
    expect(toggle.text.content).toContain('…');
    expect(toggle.text.content.endsWith(' · meeting-notes-bot')).toBe(true);
    // 完整名称仍在详情面板
    const panel = (card.body.elements as any[]).find(element => element.tag === 'collapsible_panel');
    expect(JSON.stringify(panel)).toContain(longLabel);
  });

  it('never highlights listen-only when defaults are agents and nothing is staged', () => {
    const card = JSON.parse(buildVcMeetingConsumerCard({
      selectionMode: 'profiles',
      status: 'pending',
      meeting: { id: 'm_untouched' },
      nonce: 'nonce_untouched',
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      profiles: [{
        id: 'minutes',
        agentAppId: 'cli_minutes',
        label: '纪要',
        role: 'minutes',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
      }],
    })) as any;
    const buttons = collectButtons(card.body.elements);
    const actionValue = (element: any) => element.behaviors?.find((b: any) => b?.type === 'callback')?.value;
    const clear = buttons.find(button => actionValue(button)?.action === 'vc_meeting_consumer_profile_clear');

    // 未操作 + 默认 agents：超时会跑默认 agents，只监听绝不能显示为选中
    expect(clear.type).toBe('default');
    expect(clear.text.content).toBe('☐ 只监听（不启用 agent）');
  });

  it('represents an explicitly empty staged selection as listen-only', () => {
    const card = JSON.parse(buildVcMeetingConsumerCard({
      selectionMode: 'profiles',
      status: 'pending',
      meeting: { id: 'm_empty' },
      nonce: 'nonce_empty',
      defaultMode: 'agents',
      defaultConsumerIds: ['minutes'],
      stagedSelectedProfileIds: [],
      profiles: [{
        id: 'minutes',
        agentAppId: 'cli_minutes',
        label: '纪要',
        role: 'minutes',
        responseMode: 'silent',
        capabilities: ['meeting.read'],
      }],
    })) as any;
    const elements = card.body.elements as any[];
    const buttons = collectButtons(elements);
    const actionValue = (element: any) => element.behaviors?.find((b: any) => b?.type === 'callback')?.value;
    const body = elements[0].content as string;
    const toggle = buttons.find(button => actionValue(button)?.action === 'vc_meeting_consumer_profile_toggle');
    const clear = buttons.find(button => actionValue(button)?.action === 'vc_meeting_consumer_profile_clear');

    expect(body).toContain('**当前选择**：只监听消息（空 profile 集合）（待确认）');
    expect(toggle).toMatchObject({
      type: 'default',
      behaviors: [{ value: { profile_id: 'minutes', operation: 'select', selected: true } }],
    });
    expect(clear.type).toBe('primary');
    expect(clear.text.content).toBe('☑ 只监听（不启用 agent）');
  });
});

/** 递归收集卡片按钮（含 column_set 列与折叠面板内）。 */
function collectButtons(elements: any[]): any[] {
  const buttons: any[] = [];
  const visit = (items: any[]): void => {
    for (const item of items ?? []) {
      if (item?.tag === 'button') buttons.push(item);
      if (Array.isArray(item?.elements)) visit(item.elements);
      for (const column of item?.columns ?? []) {
        if (Array.isArray(column?.elements)) visit(column.elements);
      }
    }
  };
  visit(elements);
  return buttons;
}
