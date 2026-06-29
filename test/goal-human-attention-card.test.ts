import { describe, expect, it } from 'vitest';
import { buildGoalHumanAttentionCard, buildGoalHumanAttentionResolvedCard } from '../src/im/lark/card-builder.js';

function findAll(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
  if (!node || typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, pred, out);
  } else {
    for (const value of Object.values(node)) findAll(value, pred, out);
  }
  return out;
}

describe('buildGoalHumanAttentionCard', () => {
  it('renders a decision form that carries goal routing context', () => {
    const card = JSON.parse(buildGoalHumanAttentionCard({
      ownerOpenId: 'ou_owner',
      goalTitle: 'CSV kit',
      goalChatId: 'oc_goal',
      goalLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_goal',
      taskId: 'task-1',
      attentionKind: 'decision',
      attentionReason: '需要确认 RFC4180 引号字段是否支持',
      summary: 'reviewer 要产品拍板',
      notificationMessageId: 'om_notice',
      notificationLarkAppId: 'cli_panel',
      parentChatId: 'oc_parent',
      parentRoot: 'om_parent_root',
      parentSessionId: 'l1-session',
      supervisorSessionId: 'l2-session',
    }));

    expect(card.header.title.content).toContain('任务需要你拍板');
    expect(JSON.stringify(card)).toContain('<at id=ou_owner></at>');

    const linkButton = findAll(card, (n) => n?.tag === 'button' && n?.text?.content === '打开 goal 群')[0];
    expect(linkButton.multi_url.url).toContain('openChatId=oc_goal');

    const input = findAll(card, (n) => n?.tag === 'input' && n?.name === 'goal_parent_decision_text')[0];
    expect(input.placeholder.content).toContain('决策');

    const submit = findAll(card, (n) => n?.tag === 'button' && n?.value?.action === 'goal_parent_decision')[0];
    expect(submit.action_type).toBe('form_submit');
    expect(submit.value).toMatchObject({
      goal_chat_id: 'oc_goal',
      parent_chat_id: 'oc_parent',
      parent_message_id: 'om_notice',
      notification_lark_app_id: 'cli_panel',
      task_id: 'task-1',
      parent_session_id: 'l1-session',
      supervisor_session_id: 'l2-session',
    });
  });

  it('uses the help header for help attention', () => {
    const card = JSON.parse(buildGoalHumanAttentionCard({
      goalChatId: 'oc_goal',
      parentChatId: 'oc_parent',
      attentionKind: 'help',
      summary: 'worker 缺权限',
    }));
    expect(card.header.template).toBe('blue');
    expect(card.header.title.content).toContain('worker 求助');
  });

  it('renders recommended decision option buttons alongside free text', () => {
    const card = JSON.parse(buildGoalHumanAttentionCard({
      goalTitle: 'CSV kit',
      goalChatId: 'oc_goal',
      taskId: 'task-1',
      attentionKind: 'decision',
      attentionReason: '请选择处理方式',
      summary: '需要人拍板',
      notificationMessageId: 'om_notice',
      notificationLarkAppId: 'cli_panel',
      parentChatId: 'oc_parent',
      supervisorSessionId: 'l2-session',
      decisionOptions: [
        { key: 'a', label: '支持方案 A', recommended: true },
        { key: 'b', label: '暂不支持' },
      ],
    }));

    const optionButtons = findAll(card, (n) => n?.tag === 'button' && n?.value?.action === 'goal_parent_decision_option');
    expect(optionButtons).toHaveLength(2);
    expect(optionButtons[0].type).toBe('primary');
    expect(optionButtons[0].text.content).toContain('⭐ 支持方案 A');
    expect(optionButtons[0].value).toMatchObject({
      decision_key: 'a',
      decision_text: '支持方案 A',
      goal_chat_id: 'oc_goal',
      task_id: 'task-1',
      supervisor_session_id: 'l2-session',
    });
    expect(optionButtons[1].type).toBe('default');
    expect(JSON.stringify(card)).toContain('复杂情况仍可用下方自由输入');
    expect(findAll(card, (n) => n?.tag === 'input' && n?.name === 'goal_parent_decision_text')).toHaveLength(1);
  });

  it('renders a locked resolved card after a decision is submitted', () => {
    const card = JSON.parse(buildGoalHumanAttentionResolvedCard({
      goalTitle: 'CSV kit',
      goalChatId: 'oc_goal',
      goalLink: 'https://applink.feishu.cn/client/chat/open?openChatId=oc_goal',
      taskId: 'task-1',
      summary: 'reviewer 要产品拍板',
      parentChatId: 'oc_parent',
      decisionText: '支持方案 A，今晚前给凭证',
      decisionMode: 'option',
    }));

    expect(card.header.template).toBe('green');
    expect(JSON.stringify(card)).toContain('支持方案 A');
    expect(JSON.stringify(card)).toContain('已选');
    expect(findAll(card, (n) => n?.tag === 'form')).toHaveLength(0);
    expect(findAll(card, (n) => n?.value?.action === 'goal_parent_decision')).toHaveLength(0);
    expect(JSON.stringify(card)).toContain('引用回复这张卡片');
  });
});
