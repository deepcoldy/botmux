import type { ProjectInfo } from '../../services/project-scanner.js';
import type { CliId } from '../../adapters/cli/types.js';
import type { AdoptableSession } from '../../core/session-discovery.js';

const cliDisplayNames: Record<CliId, string> = {
  'claude-code': 'Claude',
  'aiden': 'Aiden',
  'coco': 'CoCo',
  'codex': 'Codex',
  'gemini': 'Gemini',
  'opencode': 'OpenCode',
};

export function getCliDisplayName(cliId: CliId): string {
  return cliDisplayNames[cliId] ?? cliId;
}

/** Escape Lark markdown special characters in user-controlled strings. */
function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\]/g, c => `\\${c}`);
}

/**
 * Build a Feishu interactive card with terminal button + action buttons.
 * @param showManageButtons - When true, include restart & close buttons (used in DM cards with write token).
 */
export function buildSessionCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
  cliId?: CliId,
  showManageButtons?: boolean,
): string {
  const cliName = getCliDisplayName(cliId ?? 'claude-code');
  const actions: any[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: showManageButtons ? '🖥️ 打开可操作终端' : '🖥️ 打开终端' },
      type: 'primary',
      multi_url: {
        url: terminalUrl,
        pc_url: terminalUrl,
        android_url: terminalUrl,
        ios_url: terminalUrl,
      },
    },
  ];
  if (!showManageButtons) {
    // Group card: show "get write link" button (DM card already has the write token)
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔑 获取操作链接' },
      type: 'default',
      value: { action: 'get_write_link', root_id: rootId, session_id: sessionId },
    });
  }
  if (showManageButtons) {
    // DM card: include restart button
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `🔄 重启 ${cliName}` },
      type: 'default',
      value: { action: 'restart', root_id: rootId, session_id: sessionId },
    });
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '❌ 关闭会话' },
    type: 'danger',
    value: { action: 'close', root_id: rootId, session_id: sessionId },
  });
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${escapeMd(title)}` },
      template: 'blue',
    },
    elements: [
      { tag: 'action', actions },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build a Feishu streaming card that shows live terminal output + controls.
 * This card is PATCHed in-place as the CLI works.
 */
export function buildStreamingCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
  screenContent: string,
  status: 'starting' | 'working' | 'idle',
  cliId?: CliId,
  expanded?: boolean,
  cardNonce?: string,
  adoptMode?: boolean,
  showTakeover?: boolean,
): string {
  const cliName = getCliDisplayName(cliId ?? 'claude-code');
  const templateMap = { starting: 'yellow', working: 'blue', idle: 'green' } as const;
  const statusMap = { starting: '启动中…', working: '工作中', idle: '就绪' } as const;

  const elements: any[] = [];

  if (expanded) {
    const displayContent = screenContent || '(等待输出…)';
    elements.push({ tag: 'markdown', content: displayContent });
    elements.push({ tag: 'hr' });
  }

  const toggleBtn = {
    tag: 'button',
    text: { tag: 'plain_text', content: expanded ? '📕 收起输出' : '📖 展开输出' },
    type: 'default' as const,
    value: { action: 'toggle_stream', root_id: rootId, session_id: sessionId, ...(cardNonce ? { card_nonce: cardNonce } : {}) },
  };

  elements.push({
    tag: 'action',
    actions: [
      toggleBtn,
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
      ...(adoptMode
        ? [
            ...(showTakeover
              ? [{
                  tag: 'button' as const,
                  text: { tag: 'plain_text' as const, content: '🔄 接管' },
                  type: 'default' as const,
                  value: { action: 'takeover', root_id: rootId, session_id: sessionId },
                }]
              : []),
            {
              tag: 'button' as const,
              text: { tag: 'plain_text' as const, content: '⏏ 断开' },
              type: 'danger' as const,
              value: { action: 'disconnect', root_id: rootId, session_id: sessionId },
            },
          ]
        : [
            {
              tag: 'button' as const,
              text: { tag: 'plain_text' as const, content: '❌ 关闭会话' },
              type: 'danger' as const,
              value: { action: 'close', root_id: rootId, session_id: sessionId },
            },
          ]),
    ],
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${escapeMd(title)} — ${statusMap[status]}` },
      template: templateMap[status],
    },
    elements,
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

// ─── Adopt cards ─────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

export function buildAdoptSelectCard(sessions: AdoptableSession[], rootMessageId?: string): string {
  const options = sessions.map((s) => {
    const project = s.cwd.split('/').pop() || s.cwd;
    const cliName = getCliDisplayName(s.cliId);
    const uptime = s.startedAt ? formatDuration(Date.now() - s.startedAt) : '未知';
    return {
      text: { tag: 'plain_text' as const, content: `${cliName} · ${project} · ${s.tmuxTarget} · ${uptime}` },
      value: JSON.stringify({ tmuxTarget: s.tmuxTarget, cliPid: s.cliPid }),
    };
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: '📡 选择要接入的 CLI 会话' },
    },
    elements: [
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: '选择 CLI 会话' },
            options,
            value: { key: 'adopt_select', root_id: rootMessageId ?? '' },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}
