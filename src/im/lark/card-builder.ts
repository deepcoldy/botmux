import type { ProjectInfo } from '../../services/project-scanner.js';

/** Escape Lark markdown special characters in user-controlled strings. */
function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\]/g, c => `\\${c}`);
}

/**
 * Build a Feishu interactive card with terminal link + restart/close buttons.
 */
export function buildSessionCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${escapeMd(title)}` },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**终端地址：** [${terminalUrl}](${terminalUrl})\nSession: \`${sessionId.substring(0, 8)}\``,
        },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🖥️ 打开终端' },
            type: 'primary',
            multi_url: {
              url: terminalUrl,
              pc_url: terminalUrl,
              android_url: terminalUrl,
              ios_url: terminalUrl,
            },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔑 获取操作链接' },
            type: 'default',
            value: { action: 'get_write_link', root_id: rootId, session_id: sessionId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 重启 Claude' },
            type: 'default',
            value: { action: 'restart', root_id: rootId, session_id: sessionId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 关闭会话' },
            type: 'danger',
            value: { action: 'close', root_id: rootId, session_id: sessionId },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build a Feishu streaming card that shows live terminal output + controls.
 * This card is PATCHed in-place as Claude works.
 */
export function buildStreamingCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
  screenContent: string,
  status: 'starting' | 'working' | 'idle',
): string {
  const templateMap = { starting: 'yellow', working: 'blue', idle: 'green' } as const;
  const statusMap = { starting: '启动中…', working: '工作中', idle: '就绪' } as const;

  const displayContent = screenContent || '(等待输出…)';

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${escapeMd(title)} — ${statusMap[status]}` },
      template: templateMap[status],
    },
    elements: [
      {
        tag: 'markdown',
        content: displayContent,
      },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: `**终端：** [${terminalUrl}](${terminalUrl})　|　Session: \`${sessionId.substring(0, 8)}\``,
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🖥️ 打开终端' },
            type: 'primary',
            multi_url: {
              url: terminalUrl,
              pc_url: terminalUrl,
              android_url: terminalUrl,
              ios_url: terminalUrl,
            },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔑 获取操作链接' },
            type: 'default',
            value: { action: 'get_write_link', root_id: rootId, session_id: sessionId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '🔄 重启 Claude' },
            type: 'default',
            value: { action: 'restart', root_id: rootId, session_id: sessionId },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '❌ 关闭会话' },
            type: 'danger',
            value: { action: 'close', root_id: rootId, session_id: sessionId },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build a Feishu interactive card with a dropdown selector for projects.
 * Returns a JSON string suitable for msg_type: 'interactive'.
 */
export function buildRepoSelectCard(projects: ProjectInfo[], currentPath?: string, rootMessageId?: string): string {
  const options = projects.map((p, i) => {
    const currentTag = p.path === currentPath ? ' ← 当前' : '';
    const typeTag = p.type === 'worktree' ? ' [worktree]' : '';
    return {
      text: { tag: 'plain_text' as const, content: `${i + 1}. ${p.name} (${p.branch})${typeTag}${currentTag}` },
      value: p.path,
    };
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '📁 项目仓库管理' },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `当前活跃项目：**${escapeMd(currentPath ?? 'N/A')}**`,
        },
      },
      {
        tag: 'hr',
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '选择仓库并切换' },
            options,
            value: { key: 'repo_switch', root_id: rootMessageId ?? '' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '▶️ 直接开启会话' },
            type: 'primary',
            value: { action: 'skip_repo', root_id: rootMessageId ?? '' },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'lark_md',
            content: '也可以回复 `/repo <编号>` 切换，例如：`/repo 1`',
          },
        ],
      },
    ],
  };

  return JSON.stringify(card);
}
