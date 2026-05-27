import type { ProjectInfo } from '../../services/project-scanner.js';
import type { CliId } from '../../adapters/cli/types.js';
import type { AdoptableSession } from '../../core/session-discovery.js';
import type { DisplayMode, StreamStatus } from '../../types.js';
import type { CliUsageLimitState } from '../../utils/cli-usage-limit.js';
import { t, type Locale } from '../../i18n/index.js';

const cliDisplayNames: Record<CliId, string> = {
  'claude-code': 'Claude',
  'aiden': 'Aiden',
  'coco': 'CoCo',
  'codex': 'Codex',
  'cursor': 'Cursor',
  'gemini': 'Gemini',
  'opencode': 'OpenCode',
  'antigravity': 'Antigravity',
  'mtr': 'MTR',
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
 * @param adoptMode - When true, the danger button reads "⏏ 断开" with action `disconnect` (only tears down botmux's bridge worker, leaves the user's tmux pane / Claude process alone). Mutually exclusive with `showManageButtons` (DM management isn't surfaced for adopt sessions). Without this flag the card uses the original "❌ 关闭会话" button which closes the underlying CLI — wrong for adopt where we never owned the CLI in the first place.
 */
export function buildSessionCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
  cliId?: CliId,
  showManageButtons?: boolean,
  adoptMode?: boolean,
  locale?: Locale,
): string {
  const cliName = getCliDisplayName(cliId ?? 'claude-code');
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: cliId ?? 'claude-code' };
  const actions: any[] = [
    {
      tag: 'button',
      text: { tag: 'plain_text', content: t(showManageButtons ? 'card.btn.open_writable_terminal' : 'card.btn.open_terminal', undefined, locale) },
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
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.get_write_link', undefined, locale) },
      type: 'default',
      value: { action: 'get_write_link', ...actionBase },
    });
  }
  if (showManageButtons && !adoptMode) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.restart_cli', { cliName }, locale) },
      type: 'default',
      value: { action: 'restart', ...actionBase },
    });
  }
  if (adoptMode) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.disconnect', undefined, locale) },
      type: 'danger',
      value: { action: 'disconnect', ...actionBase },
    });
  } else {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.close_session', undefined, locale) },
      type: 'danger',
      value: { action: 'close', ...actionBase },
    });
  }
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${cliName} · ${escapeMd(title)}` },
      template: 'blue',
    },
    elements: [
      { tag: 'action', actions },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build the "session closed" card shown after `/close` (or the close button).
 * Surfaces a Resume button + a copyable terminal command so the user has an
 * obvious path back instead of just a dead-end status text.
 *
 * The terminal command is the *CLI's own* resume invocation (e.g.
 * `claude --resume <id>`), built by the per-CLI adapter's
 * `buildResumeCommand`. That keeps the conversation portable: users can
 * pick it up locally without going through botmux. CLIs that can't resume
 * a specific session from CLI args (gemini's "latest only", opencode)
 * surface a fallback note instead of a fake command.
 *
 * The "▶️ 恢复会话" button still goes through botmux — it re-enables the
 * Lark bridge so future replies route back into this topic.
 */
export function buildSessionClosedCard(
  sessionId: string,
  rootId: string,
  title: string,
  cliId?: CliId,
  workingDir?: string,
  cliResumeCommand?: string | null,
  locale?: Locale,
): string {
  const cliName = getCliDisplayName(cliId ?? 'claude-code');
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: cliId ?? 'claude-code' };
  const dirLine = workingDir ? `\n${t('card.body.working_dir', undefined, locale)}\`${escapeMd(workingDir)}\`` : '';
  const cmdBlock = cliResumeCommand
    ? `${t('card.body.click_resume_or_run', undefined, locale)}\n\`\`\`\n${cliResumeCommand}\n\`\`\``
    : `${t('card.body.click_resume_only', undefined, locale)}\n${t('card.body.cli_no_cli_resume', { cliName }, locale)}`;
  const body =
    `**${escapeMd(title || cliName)}**\n` +
    `${t('card.body.cli_terminated', { cliName }, locale)}${cmdBlock}` +
    dirLine;
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.status.session_closed', undefined, locale) },
      template: 'grey',
    },
    elements: [
      { tag: 'markdown', content: body },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.btn.resume_session', undefined, locale) },
            type: 'primary',
            value: { action: 'resume', ...actionBase },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Feishu card API rejects payloads exceeding ~109 KB (error 230025).
 * Cap markdown content byte size with headroom for card JSON overhead.
 */
const MAX_CONTENT_BYTES = 100_000;

/** Truncate content to fit within MAX_CONTENT_BYTES, keeping the tail (most recent output). */
export function truncateContent(content: string, locale?: Locale): string {
  if (Buffer.byteLength(content, 'utf-8') <= MAX_CONTENT_BYTES) return content;
  // Binary search for the longest suffix that fits
  const lines = content.split('\n');
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = lines.slice(mid).join('\n');
    if (Buffer.byteLength(candidate, 'utf-8') <= MAX_CONTENT_BYTES - 30) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return `${t('card.status.truncated_prefix', undefined, locale)}\n${lines.slice(lo).join('\n')}`;
}

/**
 * Build a Feishu streaming card that shows live terminal output + controls.
 * This card is PATCHed in-place as the CLI works.
 *
 * displayMode:
 *   - 'hidden'     — body collapsed; only header + main controls visible.
 *   - 'screenshot' — img element (rendered server-side, uploaded for img_key).
 *
 * Quick-action buttons (Esc, ^C, Tab, Space, Enter, ←↑↓→, ½屏 ↑/↓) appear
 * whenever displayMode !== 'hidden'.
 */
export function buildStreamingCard(
  sessionId: string,
  rootId: string,
  terminalUrl: string,
  title: string,
  screenContent: string,
  status: StreamStatus,
  cliId?: CliId,
  displayMode: DisplayMode = 'hidden',
  cardNonce?: string,
  imageKey?: string,
  adoptMode?: boolean,
  showTakeover?: boolean,
  locale?: Locale,
  usageLimit?: CliUsageLimitState,
): string {
  const effectiveCliId = cliId ?? 'claude-code';
  const cliName = getCliDisplayName(effectiveCliId);
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: effectiveCliId, ...(cardNonce ? { card_nonce: cardNonce } : {}) };
  const displayStatus = status === 'limited' && usageLimit?.retryReady ? 'retry_ready' : status;
  const templateMap = { starting: 'yellow', working: 'blue', idle: 'green', analyzing: 'purple', limited: 'red', retry_ready: 'green' } as const;
  const statusLabel = (s: typeof status): string => {
    switch (s) {
      case 'starting': return t('card.status.starting', undefined, locale);
      case 'working': return t('card.status.working', undefined, locale);
      case 'idle': return t('card.status.idle', undefined, locale);
      case 'analyzing': return t('card.status.analyzing', undefined, locale);
      case 'limited': return usageLimit?.retryReady
        ? t('card.status.retry_ready', undefined, locale)
        : t('card.status.limited', undefined, locale);
    }
  };

  const elements: any[] = [];

  // ── Output body ─────────────────────────────────────────────────────────
  if (status === 'limited' && usageLimit) {
    elements.push({
      tag: 'markdown',
      content: usageLimit.retryReady
        ? t('card.usage_limit.retry_ready', { cliName }, locale)
        : t('card.usage_limit.retry_at', { cliName, retryLabel: usageLimit.retryLabel }, locale),
    });
    elements.push({ tag: 'hr' });
  }

  if (displayMode === 'screenshot') {
    if (imageKey) {
      elements.push({
        tag: 'img',
        img_key: imageKey,
        alt: { tag: 'plain_text', content: '' },
        mode: 'fit_horizontal',
        preview: true,
      });
    } else {
      elements.push({ tag: 'markdown', content: t('card.status.waiting_screenshot', undefined, locale) });
    }
    elements.push({ tag: 'hr' });
  }

  // ── Main control row: display toggle, mode toggle, terminal, manage ─────
  const headerActions: any[] = [];

  headerActions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t(displayMode === 'hidden' ? 'card.btn.show_output' : 'card.btn.hide_output', undefined, locale) },
    type: 'default' as const,
    value: { action: 'toggle_display', ...actionBase },
  });
  if (displayMode !== 'hidden') {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.export_text', undefined, locale) },
      type: 'default' as const,
      value: { action: 'export_text', ...actionBase },
    });
  }
  if (displayMode === 'screenshot') {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.refresh', undefined, locale) },
      type: 'default' as const,
      value: { action: 'refresh_screenshot', ...actionBase },
    });
  }
  headerActions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.btn.open_terminal', undefined, locale) },
    type: 'primary',
    multi_url: { url: terminalUrl, pc_url: terminalUrl, android_url: terminalUrl, ios_url: terminalUrl },
  });
  if (status === 'limited' && usageLimit?.retryReady) {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.retry_last_task', undefined, locale) },
      type: 'primary' as const,
      value: { action: 'retry_last_task', ...actionBase },
    });
  }
  headerActions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.btn.get_write_link', undefined, locale) },
    type: 'default',
    value: { action: 'get_write_link', ...actionBase },
  });
  if (adoptMode) {
    if (showTakeover) {
      headerActions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.btn.takeover', undefined, locale) },
        type: 'default' as const,
        value: { action: 'takeover', ...actionBase },
      });
    }
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.disconnect', undefined, locale) },
      type: 'danger' as const,
      value: { action: 'disconnect', ...actionBase },
    });
  } else {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.close_session', undefined, locale) },
      type: 'danger' as const,
      value: { action: 'close', ...actionBase },
    });
  }
  elements.push({ tag: 'action', actions: headerActions });

  // ── Quick-action keys (only when the screenshot is visible — in text mode
  //    there's no visible cursor/input, so these keys would fire blindly) ──
  if (displayMode === 'screenshot') {
    const mkKey = (label: string, key: string) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type: 'default' as const,
      value: { action: 'term_action', ...actionBase, key },
    });
    elements.push({
      tag: 'action',
      actions: [
        mkKey('Esc', 'esc'),
        mkKey('^C', 'ctrlc'),
        mkKey('Tab', 'tab'),
        mkKey('␣ Space', 'space'),
        mkKey('↵ Enter', 'enter'),
      ],
    });
    elements.push({
      tag: 'action',
      actions: [
        mkKey('←', 'left'),
        mkKey('↑', 'up'),
        mkKey('↓', 'down'),
        mkKey('→', 'right'),
        mkKey(t('card.btn.half_page_up', undefined, locale), 'half_page_up'),
        mkKey(t('card.btn.half_page_down', undefined, locale), 'half_page_down'),
      ],
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🖥️ ${cliName} · ${escapeMd(title)} — ${statusLabel(status)}` },
      template: templateMap[displayStatus],
    },
    elements,
  };
  return JSON.stringify(card);
}

/**
 * Build a Feishu interactive card with a dropdown selector for projects.
 * Returns a JSON string suitable for msg_type: 'interactive'.
 */
export function buildRepoSelectCard(projects: ProjectInfo[], currentPath?: string, rootMessageId?: string, locale?: Locale): string {
  const currentMarker = t('card.repo.current_marker', undefined, locale);
  const options = projects.map((p, i) => {
    const currentTag = p.path === currentPath ? currentMarker : '';
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
      title: { tag: 'plain_text', content: t('card.repo.title', undefined, locale) },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `${t('card.repo.current_active', undefined, locale)}**${escapeMd(currentPath ?? 'N/A')}**`,
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
            placeholder: { tag: 'plain_text', content: t('card.repo.placeholder_switch', undefined, locale) },
            options,
            value: { key: 'repo_switch', root_id: rootMessageId ?? '' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.btn.skip_repo', undefined, locale) },
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
            content: t('card.repo.note', undefined, locale),
          },
        ],
      },
    ],
  };

  return JSON.stringify(card);
}

// ─── 群内授权卡片 ─────────────────────────────────────────────────────────────

export interface GrantCardOpts {
  ownerOpenId: string;
  requesterOpenId: string;
  requesterName: string;
  chatId: string;
  nonce: string;
  /** 'request' = 无权限者自助申请；'owner' = owner 主动 /grant。仅文案不同。 */
  mode: 'request' | 'owner';
}

/** 授权卡片：正文 @owner，三枚按钮各带 action + 上下文 + nonce。 */
export function buildGrantCard(o: GrantCardOpts, locale?: Locale): string {
  const body = o.mode === 'request'
    ? t('card.grant.body_request', { name: escapeMd(o.requesterName), owner: o.ownerOpenId }, locale)
    : t('card.grant.body_owner', { name: escapeMd(o.requesterName), owner: o.ownerOpenId }, locale);
  const v = { target_open_id: o.requesterOpenId, chat_id: o.chatId, nonce: o.nonce };
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: t('card.grant.title', undefined, locale) } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body } },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: t('card.grant.btn_chat', undefined, locale) }, value: { action: 'grant_chat', ...v } },
          { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: t('card.grant.btn_deny', undefined, locale) }, value: { action: 'grant_deny', ...v } },
        ],
      },
      { tag: 'note', elements: [{ tag: 'lark_md', content: t('card.grant.note', undefined, locale) }] },
    ],
  };
  return JSON.stringify(card);
}

/** 授权成功后给被授权人的通知卡（@ 对方，独立消息）。 */
export function buildGrantNotifyCard(kind: 'chat' | 'global', targetOpenId: string, locale?: Locale): string {
  const at = `<at id=${targetOpenId}></at>`;
  const content = t(kind === 'chat' ? 'card.grant.notify_chat' : 'card.grant.notify_global', { at }, locale);
  const card = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
  };
  return JSON.stringify(card);
}

/** 授权处置后的终态卡（无按钮，防重复点击）。 */
export function buildGrantResultCard(kind: 'chat' | 'global' | 'deny', locale?: Locale): string {
  const key = kind === 'chat' ? 'card.grant.result_chat' : kind === 'global' ? 'card.grant.result_global' : 'card.grant.result_deny';
  const card = {
    config: { wide_screen_mode: true },
    header: { template: kind === 'deny' ? 'grey' : 'green', title: { tag: 'plain_text', content: t('card.grant.title', undefined, locale) } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: t(key, undefined, locale) } }],
  };
  return JSON.stringify(card);
}

// ─── TUI Prompt cards ───────────────────────────────────────────────────────

/**
 * Build a Feishu interactive card for a TUI prompt detected by ScreenAnalyzer.
 * Select-type options get buttons; input-type options shown in list with a note.
 */
export function buildTuiPromptCard(
  rootId: string,
  sessionId: string,
  description: string,
  options: Array<{ label?: string; text: string; selected: boolean; type?: string; keys?: string[] }>,
  multiSelect?: boolean,
  toggledIndices?: number[],
  locale?: Locale,
): string {
  const hasInputOption = options.some(o => o.type === 'input');
  const toggled = new Set(toggledIndices ?? []);

  // Build option list — skip confirm-type (shown as button only)
  const optionLines = options
    .filter(o => o.type !== 'confirm')
    .map((opt) => {
      const i = options.indexOf(opt);
      const label = opt.label || String(i + 1);
      if (opt.type === 'toggle') {
        const check = toggled.has(i) ? '☑' : '☐';
        return `${check} ${label}. ${escapeMd(opt.text)}`;
      }
      return opt.selected
        ? `**${label}. ${escapeMd(opt.text)}**`
        : `${label}. ${escapeMd(opt.text)}`;
    }).join('\n');

  // Build buttons — each carries its AI-provided key sequence
  const buttons: any[] = [];
  for (const opt of options) {
    const originalIndex = options.indexOf(opt);
    if (opt.type === 'input') continue;

    const isFinal = opt.type === 'select' || opt.type === 'confirm';
    const btnLabel = opt.type === 'confirm'
      ? `✅ ${opt.text}`
      : (opt.label || String(originalIndex + 1));

    buttons.push({
      tag: 'button' as const,
      text: { tag: 'plain_text' as const, content: btnLabel },
      type: ((opt.type === 'confirm' || toggled.has(originalIndex)) ? 'primary' : opt.selected ? 'primary' : 'default') as 'primary' | 'default',
      value: {
        action: 'tui_keys',
        root_id: rootId,
        session_id: sessionId,
        keys: JSON.stringify(opt.keys ?? []),
        is_final: isFinal ? '1' : '0',
        selected_index: String(originalIndex),
        selected_text: opt.text,
        option_type: opt.type ?? 'select',
      },
    });
  }

  const elements: any[] = [
    {
      tag: 'div',
      text: { tag: 'lark_md', content: optionLines },
    },
    { tag: 'hr' },
    { tag: 'action', actions: buttons },
  ];

  // Form with input field for "Type something" options
  if (hasInputOption) {
    const inputOpt = options.find(o => o.type === 'input');
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'form',
      name: 'tui_input_form',
      elements: [
        {
          tag: 'input',
          name: 'tui_custom_input',
          placeholder: { tag: 'plain_text', content: t('card.tui.input_placeholder', undefined, locale) },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.btn.send_custom', undefined, locale) },
          type: 'primary',
          name: 'tui_input_submit',
          action_type: 'form_submit',
          value: {
            action: 'tui_text_input',
            root_id: rootId,
            session_id: sessionId,
            input_keys: JSON.stringify(inputOpt?.keys ?? []),
          },
        },
      ],
    });
  }

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: escapeMd(description) },
      template: 'orange',
    },
    elements,
  };
  return JSON.stringify(card);
}

/**
 * Build a "processing" TUI prompt card — shown immediately when user clicks a button.
 */
export function buildTuiPromptProcessingCard(selectedText: string, locale?: Locale): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.status.executing', undefined, locale) },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `${t('card.body.choose_label', undefined, locale)} **${escapeMd(selectedText)}**` },
      },
    ],
  };
  return JSON.stringify(card);
}

/**
 * Build a resolved TUI prompt card — shows which option was selected.
 */
export function buildTuiPromptResolvedCard(selectedText: string, locale?: Locale): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.status.selected', undefined, locale) },
      template: 'green',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**${escapeMd(selectedText)}**` },
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

// ─── /relay picker (pull mode) ──────────────────────────────────────────────

export interface RelayPickerEntry {
  sessionId: string;
  /** Short human label for the source chat — chat name if resolvable, else chatId. */
  chatLabel: string;
  /** First-turn title or current-turn topic — already truncated by the caller. */
  title: string;
  /** Absolute working dir, displayed verbatim. */
  workingDir?: string;
  /** CLI identifier, used to render a friendly name. */
  cliId?: CliId;
  /** Last activity timestamp, used to render a relative duration. */
  lastMessageAt?: number;
  /** Source chat's conversational topology. Drives the type tag in the
   *  picker. Caller supplies based on getChatNameAndMode lookup + the
   *  session's own chatType for the p2p case. */
  chatMode?: 'group' | 'topic' | 'p2p';
}

function relayPickerTypeTag(mode: 'group' | 'topic' | 'p2p' | undefined, locale?: Locale): string {
  switch (mode) {
    case 'p2p':   return t('card.relay.type_p2p',   undefined, locale);
    case 'topic': return t('card.relay.type_topic', undefined, locale);
    default:      return t('card.relay.type_group', undefined, locale); // 'group' or undefined
  }
}

export interface RelayPickerState {
  /** Currently selected sessionId, if any (drives the highlight + confirm button). */
  selectedSessionId?: string;
  /** Case-insensitive substring filter applied to title / chatLabel / workingDir. */
  searchQuery?: string;
  /** 0-indexed page within the filtered list. Clamped to valid range at render time. */
  page?: number;
}

const RELAY_PICKER_PAGE_SIZE = 5;
const RELAY_SEARCH_FIELD = 'search';

/**
 * Match against title / chatLabel / workingDir / cliId. Case-insensitive
 * substring. Empty / whitespace query matches everything.
 */
function relayPickerFilter(entries: RelayPickerEntry[], query: string | undefined): RelayPickerEntry[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const haystack = [e.title, e.chatLabel, e.workingDir, e.cliId]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Card listing the operator's relayable sessions, paginated 5 per page with
 * a search box at the top and a confirm button at the bottom. Layout:
 *
 *   ┌──────────────────────────────────────┐
 *   │ 📋 选择要接力的会话                   │  header
 *   ├──────────────────────────────────────┤
 *   │ 🔍 [______________] [搜索]            │  form: input + submit button
 *   ├──────────────────────────────────────┤
 *   │  [interactive_container 1]            │  current page (≤5 cards),
 *   │  [interactive_container 2]            │  each clickable for selection
 *   │   ...                                 │
 *   ├──────────────────────────────────────┤
 *   │  [← 上一页]  1 / 4  [下一页 →]        │  paginator row
 *   ├──────────────────────────────────────┤
 *   │   [确认接力到本群]                    │  primary button (only when
 *   │                                       │   a selected session is on
 *   │                                       │   the current filtered set)
 *   └──────────────────────────────────────┘
 *
 * State (search / page / selected) is propagated entirely via the value
 * objects on each button and container — Lark cards are stateless, so any
 * server-side re-render must reconstruct from what the click sent us.
 * That's why every interactive value here carries `search`, `page`,
 * `target_chat_id`, `root_id`.
 *
 * Note: typing into the search box without clicking 搜索 does NOT update
 * the in-callback state — container/paginator clicks use whatever search
 * was applied at card-render time. To apply a new filter, click 搜索.
 */
export function buildRelayPickerCard(
  entries: RelayPickerEntry[],
  targetChatId: string,
  targetRootMessageId: string,
  locale?: Locale,
  state?: RelayPickerState,
): string {
  const searchQuery = state?.searchQuery ?? '';
  const requestedPage = state?.page ?? 0;
  const selectedSessionId = state?.selectedSessionId;
  const elements: any[] = [];

  // ─── Filter & paginate ───────────────────────────────────────────────
  const filtered = relayPickerFilter(entries, searchQuery);
  const totalPages = Math.max(1, Math.ceil(filtered.length / RELAY_PICKER_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  const start = page * RELAY_PICKER_PAGE_SIZE;
  const visible = filtered.slice(start, start + RELAY_PICKER_PAGE_SIZE);

  // Common state object carried by every interactive value so re-renders
  // can reconstruct what the user was looking at.
  const stateValue = {
    target_chat_id: targetChatId,
    root_id: targetRootMessageId,
    search: searchQuery,
    page,
    selected: selectedSessionId ?? '',
  };

  // ─── Search box (form) ──────────────────────────────────────────────
  // form_submit on the 搜索 button collects the input value into
  // form_value.search; daemon re-renders with that as the new query.
  elements.push({
    tag: 'form',
    name: 'relay_picker_form',
    elements: [
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'default',
        columns: [
          {
            tag: 'column',
            width: 'weighted',
            weight: 5,
            vertical_align: 'center',
            elements: [
              {
                tag: 'input',
                name: RELAY_SEARCH_FIELD,
                placeholder: { tag: 'plain_text', content: t('card.relay.search_placeholder', undefined, locale) },
                default_value: searchQuery,
                width: 'fill',
              },
            ],
          },
          {
            tag: 'column',
            width: 'weighted',
            weight: 1,
            vertical_align: 'center',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: t('card.relay.btn_search', undefined, locale) },
                action_type: 'form_submit',
                name: 'relay_picker_search_btn',
                value: { action: 'relay_search', ...stateValue, selected: '' /* reset selection on new search */ },
              },
            ],
          },
        ],
      },
    ],
  });

  elements.push({ tag: 'hr' });

  // ─── Empty / no-match notice ────────────────────────────────────────
  if (entries.length === 0) {
    elements.push({ tag: 'markdown', content: t('card.relay.empty', undefined, locale) });
    return JSON.stringify(wrapCard(elements, locale));
  }
  if (filtered.length === 0) {
    elements.push({
      tag: 'markdown',
      content: t('card.relay.empty_filtered', { query: searchQuery }, locale),
    });
    return JSON.stringify(wrapCard(elements, locale));
  }

  // ─── Session cards (current page) ───────────────────────────────────
  const p2pLocationLabel = t('card.relay.type_p2p', undefined, locale);
  const labelType     = t('card.relay.field_type',     undefined, locale);
  const labelLocation = t('card.relay.field_location', undefined, locale);
  const labelTime     = t('card.relay.field_time',     undefined, locale);
  const selectedTag   = t('card.relay.selected_tag',   undefined, locale);
  const hasValidSelection = !!selectedSessionId && filtered.some(e => e.sessionId === selectedSessionId);

  visible.forEach((e) => {
    const isSelected = e.sessionId === selectedSessionId;
    const typeTag = relayPickerTypeTag(e.chatMode, locale);
    const locationLine = e.chatMode === 'p2p' ? p2pLocationLabel : e.chatLabel;
    const titleLine = isSelected
      ? `**✅ ${escapeMd(e.title)}** \`${selectedTag}\``
      : `**${escapeMd(e.title)}**`;
    const lines: string[] = [
      titleLine,
      `${labelType}: ${typeTag}`,
      `${labelLocation}: ${escapeMd(locationLine)}`,
    ];
    if (e.lastMessageAt) {
      lines.push(`${labelTime}: ${formatDuration(Date.now() - e.lastMessageAt)}`);
    }
    elements.push({
      tag: 'interactive_container',
      width: 'fill',
      padding: '8px 12px',
      background_style: isSelected ? 'laser' : 'default',
      has_border: true,
      border_color: isSelected ? 'blue-500' : 'grey-200',
      corner_radius: '8px',
      behaviors: [
        {
          type: 'callback',
          value: { action: 'relay_select', session_id: e.sessionId, ...stateValue },
        },
      ],
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    });
  });

  // ─── Paginator (only when more than one page) ───────────────────────
  if (totalPages > 1) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'default',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: t('card.relay.btn_prev_page', undefined, locale) },
              type: 'default',
              disabled: page === 0,
              behaviors: [
                {
                  type: 'callback',
                  value: { action: 'relay_page', ...stateValue, page: Math.max(0, page - 1) },
                },
              ],
            },
          ],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 2,
          vertical_align: 'center',
          elements: [
            {
              tag: 'markdown',
              text_align: 'center',
              content: t('card.relay.page_indicator', { current: page + 1, total: totalPages }, locale),
            },
          ],
        },
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          vertical_align: 'center',
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: t('card.relay.btn_next_page', undefined, locale) },
              type: 'default',
              disabled: page === totalPages - 1,
              behaviors: [
                {
                  type: 'callback',
                  value: { action: 'relay_page', ...stateValue, page: Math.min(totalPages - 1, page + 1) },
                },
              ],
            },
          ],
        },
      ],
    });
  }

  // ─── Confirm button or hint ─────────────────────────────────────────
  elements.push({ tag: 'hr' });
  if (hasValidSelection) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: t('card.relay.btn_confirm', undefined, locale) },
              type: 'primary',
              behaviors: [
                {
                  type: 'callback',
                  value: { action: 'relay_confirm', session_id: selectedSessionId, ...stateValue },
                },
              ],
            },
          ],
        },
      ],
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${t('card.relay.hint_pick_first', undefined, locale)}</font>`,
    });
  }

  return JSON.stringify(wrapCard(elements, locale));
}

function wrapCard(elements: any[], locale?: Locale): any {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: t('card.relay.title', undefined, locale) },
      template: 'blue',
    },
    body: { direction: 'vertical', elements },
  };
}

export function buildAdoptSelectCard(sessions: AdoptableSession[], rootMessageId?: string, locale?: Locale): string {
  const unknownUptime = t('card.adopt.uptime_unknown', undefined, locale);
  const options = sessions.map((s) => {
    const project = s.cwd.split('/').pop() || s.cwd;
    const cliName = getCliDisplayName(s.cliId);
    const uptime = s.startedAt ? formatDuration(Date.now() - s.startedAt) : unknownUptime;
    return {
      text: { tag: 'plain_text' as const, content: `${cliName} · ${project} · ${s.tmuxTarget} · ${uptime}` },
      value: JSON.stringify({ tmuxTarget: s.tmuxTarget, cliPid: s.cliPid }),
    };
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('card.adopt.title', undefined, locale) },
    },
    elements: [
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: t('card.adopt.placeholder_select', undefined, locale) },
            options,
            value: { key: 'adopt_select', root_id: rootMessageId ?? '' },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}
