import { isRemoteCliId } from '../../core/remote-cli-ids.js';
import { cliHasNoRawPassthroughSurface } from '../../core/passthrough-commands.js';
import type { ProjectInfo } from '../../services/project-scanner.js';
import type { CliId, ResumableSession } from '../../adapters/cli/types.js';
import { adoptTargetKey, adoptTargetLabel, type AdoptableSession } from '../../core/session-discovery.js';
import type { ZellijAdoptableSession } from '../../core/zellij-adopt-discovery.js';
import type { CodexAppThreadSummary } from '../../services/codex-app-threads.js';
import type { DisplayMode, StreamStatus } from '../../types.js';
import type { CliUsageLimitState } from '../../utils/cli-usage-limit.js';
import type { TurnRetryOffer } from '../../services/turn-failure-notice.js';
import { t, type Locale } from '../../i18n/index.js';
import { cardUsageFooterSegment, cardUsageRuntimeSegment, contextOverCompactThreshold, type CardUsageSnapshot } from './md-card.js';
import { readGlobalConfig } from '../../global-config.js';
import type { ConfigCardData } from '../../services/bot-config-store.js';
import { isLocalCliOpenEnabled } from '../../services/local-cli-opener.js';
import {
  clampGrantQuotaForCard,
  DEFAULT_GRANT_DURATION_MS,
  DEFAULT_GRANT_QUOTA,
  GRANT_DURATION_OPTIONS,
  MAX_GRANT_QUOTA,
} from '../../services/grant-policy.js';
import type { GoalDecisionOption } from '../../services/goal-decision-options.js';

/** select_static 里代表「清回默认 / 未设置」的哨兵值（model / lang 下拉用）。 */
export const CONFIG_UNSET = '__unset__';

/** 流式卡片上下文占用百分比变色/高亮的缺省阈值（dashboard.contextCompactThreshold
 *  缺省或非法时使用）。readGlobalConfig 自带 2s TTL 缓存，每次卡片构建调用成本极低。 */
export const DEFAULT_CONTEXT_COMPACT_THRESHOLD = 80;

/** 上下文占用百分比阈值：读 global-config 的 dashboard.contextCompactThreshold，
 *  校验 finite 且 1..100，否则回退默认 80（与 readDashboard 的 lenient 读法一致）。 */
export function contextCompactThreshold(): number {
  const v = readGlobalConfig().dashboard?.contextCompactThreshold;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100) return Math.round(v);
  return DEFAULT_CONTEXT_COMPACT_THRESHOLD;
}

/** 布尔字段按配置页的逻辑分组（与 dashboard 的 Bot Profiles 区块对应）。 */
const CONFIG_CARD_BOOLEAN_GROUPS: ReadonlyArray<{ sec: string; keys: readonly string[] }> = [
  { sec: 'card.config.sec.card', keys: ['disableStreamingCard', 'silentTurnReactions', 'writableTerminalLinkInCard', 'privateCard'] },
  { sec: 'card.config.sec.autostart', keys: ['autoStartOnGroupJoin', 'autoStartOnNewTopic'] },
  { sec: 'card.config.sec.security', keys: ['disableCliBypass', 'restrictGrantCommands', 'p2pOpen'] },
];

function configSelect(placeholder: string, initial: string, options: Array<{ text: string; value: string }>, value: Record<string, string>): any {
  return {
    tag: 'select_static',
    placeholder: { tag: 'plain_text', content: placeholder },
    initial_option: initial,
    options: options.map(o => ({ text: { tag: 'plain_text', content: o.text }, value: o.value })),
    value,
  };
}

function configSubheader(secKey: string, locale?: Locale): any {
  return { tag: 'div', text: { tag: 'lark_md', content: `**${t(secKey, undefined, locale)}**` } };
}

/**
 * 交互配置卡片：`/botconfig`（裸）返回它。按配置页逻辑分区（运行 / 卡片行为 / 主动开工 /
 * 安全·授权），cli·model·lang 用下拉，布尔字段用切换按钮（i18n 文案 + ✅/⬜️），消息额度
 * 展示当前值并通过独立输入卡修改。即时项在卡片回调后刷新。
 * 只吃纯数据 {@link ConfigCardData}，不反向依赖 store，避免循环依赖。
 */
export function buildConfigCard(data: ConfigCardData, locale?: Locale): string {
  const def = t('card.config.default', undefined, locale);
  // 把渲染语言带进每个 action value，使点按钮后的就地重渲染保持同一语言
  // （`/botconfig en` 的覆盖不会因为一次 toggle 又退回 bot 默认语言）。
  const locVal: Record<string, string> = locale ? { loc: locale } : {};
  const elements: any[] = [];

  elements.push({
    tag: 'div',
    text: {
      tag: 'lark_md',
      content: t('card.config.summary', {
        cli: data.cliId, model: data.model ?? def, lang: data.lang ?? def, admins: data.admins,
      }, locale),
    },
  });

  // ── 🧠 运行: cli / model / lang ─────────────────────────────────────────
  elements.push({ tag: 'hr' });
  elements.push(configSubheader('card.config.sec.runtime', locale));
  const runSelects: any[] = [
    configSelect('CLI', data.cliId, data.cliOptions.map(o => ({ text: o.label, value: o.id })), { action: 'config_set', field: 'cli', ...locVal }),
  ];
  if (data.modelChoices.length > 0) {
    runSelects.push(configSelect('model', data.model ?? CONFIG_UNSET,
      [{ text: def, value: CONFIG_UNSET }, ...data.modelChoices.map(m => ({ text: m, value: m }))],
      { action: 'config_set', field: 'model', ...locVal }));
  }
  runSelects.push(configSelect('lang', data.lang ?? CONFIG_UNSET,
    [{ text: def, value: CONFIG_UNSET }, { text: '中文 (zh)', value: 'zh' }, { text: 'English (en)', value: 'en' }],
    { action: 'config_set', field: 'lang', ...locVal }));
  // 私聊单聊模式：chat（默认，扁平连续会话）| thread（每条 DM 独立会话）| group
  //（每条 DM 自动建专属会话群）。chat 与未设等价，故 chat 选项用 unset 哨兵：
  // 选它即清字段、回默认（扁平连续 DM），避免把字面 'chat' 写进 bots.json（与
  // dashboard 下拉一致，/botconfig get 重启前后一致）。只有显式 'thread' /
  // 'group' 才是需要落盘的值——回显同样按这三态，已配 group 不再错显为 chat。
  runSelects.push(configSelect(
    t('card.config.p2p.placeholder', undefined, locale),
    data.p2pMode === 'thread' ? 'thread' : data.p2pMode === 'group' ? 'group' : CONFIG_UNSET,
    [
      { text: t('card.config.p2p.chat', undefined, locale), value: CONFIG_UNSET },
      { text: t('card.config.p2p.thread', undefined, locale), value: 'thread' },
      { text: t('card.config.p2p.group', undefined, locale), value: 'group' },
    ],
    { action: 'config_set', field: 'p2pMode', ...locVal }));
  elements.push({ tag: 'action', actions: runSelects });

  // ── 布尔开关分组 ─────────────────────────────────────────────────────────
  const onMap = new Map(data.booleans.map(b => [b.key, b.on]));
  for (const g of CONFIG_CARD_BOOLEAN_GROUPS) {
    const btns = g.keys.filter(k => onMap.has(k)).map(k => {
      const on = onMap.get(k) === true;
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: `${on ? '🟢' : '⚪'} ${t('config.label.' + k, undefined, locale)}` },
        type: on ? 'primary' : 'default',
        value: { action: 'config_toggle', field: k, ...locVal },
      };
    });
    elements.push({ tag: 'hr' });
    elements.push(configSubheader(g.sec, locale));
    elements.push({ tag: 'action', actions: btns });
    // 安全·授权区展示当前额度，自由输入放在独立子卡。
    // v1 form 不能被卡片 patch 稳定重渲染，否则切换其它开关可能变空卡。
    if (g.sec === 'card.config.sec.security') {
      const legacyQuota = data.quota != null && data.quota > MAX_GRANT_QUOTA;
      elements.push({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: data.quota == null
            ? t('card.config.quota_off', undefined, locale)
            : legacyQuota
              ? t('card.config.quota_legacy_note', {
                quota: data.quota,
                cardQuota: MAX_GRANT_QUOTA,
              }, locale)
              : t('card.config.quota_value', { quota: data.quota }, locale),
        },
      });
      elements.push({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.config.quota_edit', undefined, locale) },
          type: 'default',
          value: { action: 'config_quota_open', ...locVal },
        }],
      });
    }
  }

  // 自由文本字段（brandLabel / 入群首轮 prompt / 默认角色）不放主卡（v1 主卡只下拉+开关），
  // 用一个按钮唤起带输入框的「文本设置」子卡（见 buildConfigTextCard / config_text_open）。
  elements.push({ tag: 'hr' });
  elements.push({
    tag: 'action',
    actions: [{
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.config.text_btn', undefined, locale) },
      type: 'default',
      value: { action: 'config_text_open', ...locVal },
    }],
  });
  elements.push({ tag: 'note', elements: [{ tag: 'lark_md', content: t('card.config.note', undefined, locale) }] });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: t('card.config.title', { name: data.botName }, locale) } },
    elements,
  });
}

/**
 * 消息额度输入子卡：接受 1–1000 的任意整数，留空恢复内置策略。
 * 使用独立新卡承载 v1 form，避免主配置卡的开关 patch 到含 form 的卡体。
 */
export function buildConfigQuotaCard(data: ConfigCardData, locale?: Locale): string {
  const locVal: Record<string, string> = locale ? { loc: locale } : {};
  const legacyQuota = data.quota != null && data.quota > MAX_GRANT_QUOTA;
  const elements: any[] = [
    { tag: 'div', text: { tag: 'lark_md', content: t('card.config.quota_input_note', undefined, locale) } },
  ];
  if (legacyQuota) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: t('card.config.quota_legacy_note', {
          quota: data.quota ?? '',
          cardQuota: MAX_GRANT_QUOTA,
        }, locale),
      },
    });
  }
  elements.push({
    tag: 'form',
    name: 'config_quota_form',
    elements: [
      {
        tag: 'input',
        name: 'messageQuota',
        default_value: legacyQuota || data.quota == null ? '' : String(data.quota),
        placeholder: { tag: 'plain_text', content: t('card.config.quota_input_placeholder', undefined, locale) },
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.config.save', undefined, locale) },
        type: 'primary',
        name: 'config_quota_save',
        action_type: 'form_submit',
        value: { action: 'config_quota_save', ...locVal },
      },
    ],
  });
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('card.config.quota_input_title', { name: data.botName }, locale) },
    },
    elements,
  });
}

/**
 * 「文本设置」子卡：从主配置卡点「✏️ 文本设置」唤起。承载自由文本字段——卡片签名
 * （brandLabel）、入群首轮 prompt（autoStartOnGroupJoinPrompt）、默认角色（team role）。
 * v1 `form`+`input` 实现（仓库已验证），输入框预填当前值，一个「保存」提交全部
 * （form_submit → config_text_save），留空=清除该项；「⬅ 返回」回主卡（config_back）。
 */
export function buildConfigTextCard(data: ConfigCardData, locale?: Locale): string {
  const locVal: Record<string, string> = locale ? { loc: locale } : {};
  // 每个字段 = 标签 div（在 form 外）+ 一个仅含 [input, 保存按钮] 的 form。
  // form 内只放 input+button（与仓库已验证的 TUI 表单同构），label 放 form 外，
  // 否则 form 里混入 div 会整卡渲染失败（空卡）。每字段独立保存。
  const section = (lblKey: string, name: string, value: string | null): any[] => ([
    { tag: 'div', text: { tag: 'lark_md', content: `**${t(lblKey, undefined, locale)}**` } },
    {
      tag: 'form',
      name: `config_form_${name}`,
      elements: [
        { tag: 'input', name, default_value: value ?? '', placeholder: { tag: 'plain_text', content: t(lblKey, undefined, locale) } },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: t('card.config.save', undefined, locale) },
          type: 'primary',
          name: `config_save_${name}`,
          action_type: 'form_submit',
          value: { action: 'config_text_save', field: name, ...locVal },
        },
      ],
    },
  ]);
  const elements: any[] = [
    { tag: 'div', text: { tag: 'lark_md', content: t('card.config.text_note', undefined, locale) } },
    { tag: 'hr' },
    ...section('card.config.lbl_brand', 'brandLabel', data.brandLabel),
    { tag: 'hr' },
    ...section('card.config.lbl_prompt', 'autoStartPrompt', data.autoStartPrompt),
    { tag: 'hr' },
    ...section('card.config.lbl_passthrough', 'customPassthroughCommands', data.customPassthroughCommands),
    { tag: 'hr' },
    ...section('card.config.lbl_startup', 'startupCommands', data.startupCommands),
    { tag: 'hr' },
    ...section('card.config.lbl_role', 'teamRole', data.teamRole),
  ];
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'blue', title: { tag: 'plain_text', content: t('card.config.text_title', { name: data.botName }, locale) } },
    elements,
  });
}

const cliDisplayNames: Record<CliId, string> = {
  'claude-code': 'Claude',
  'seed': 'Seed',
  'relay': 'Relay',
  'aiden': 'Aiden',
  'coco': 'CoCo',
  'codex': 'Codex',
  'codex-app': 'Codex App',
  'cursor': 'Cursor',
  'gemini': 'Gemini',
  'genius': 'Genius',
  'opencode': 'OpenCode',
  'opencode2': 'OpenCode 2',
  'antigravity': 'Antigravity',
  'mtr': 'MTR',
  'hermes': 'Hermes',
  'mira': 'Mira',
  'mir': 'Mir CLI',
  'traex': 'TRAE',
  'pi': 'Pi',
  'copilot': 'Copilot',
  'oh-my-pi': 'Oh My Pi',
  'ebsd': 'ebsd',
  'kimi': 'Kimi',
  'grok': 'Grok Build',
  'kiro-cli': 'Kiro',
  'riff': 'Riff',
  'reasonix': 'Reasonix',
  'dsh': 'DeepSeek Harness',
  'dsh-tui': 'DeepSeek Harness TUI',
  'mojo': 'Mojo',
};

export function getCliDisplayName(cliId: CliId): string {
  return cliDisplayNames[cliId] ?? cliId;
}

/** Escape Lark markdown special characters in user-controlled strings.
 *  `<`/`>` are escaped too so an attacker-controlled name (e.g. a foreign
 *  bot's app name surfaced in the grant card) cannot inject a literal
 *  `<at id=…></at>` tag and spoof a mention in a `lark_md` body. */
function escapeMd(s: string): string {
  return s.replace(/[*_~`\[\]\\<>]/g, c => `\\${c}`);
}

/** Sanitize a user-derived string for a `plain_text` HEADER title. Unlike
 *  {@link escapeMd} (for `lark_md` bodies), a plain_text field renders literally
 *  — so markdown-escaping would surface visible backslashes, and a raw
 *  `<at id=…></at>` carried over from the seeding message shows as the literal
 *  tag text (both seen leaking in the header). Strip mention markup entirely (a
 *  title should never carry a mention), collapse the whitespace it leaves, and
 *  drop stray angle brackets so no tag-like text survives. No backslashes: the
 *  field is not markdown. */
function plainTitle(s: string): string {
  return s
    .replace(/<at\b[^>]*>.*?<\/at>/gis, '') // drop <at ...>…</at> mention markup
    .replace(/<at\b[^>]*\/?>/gis, '')       // drop any unbalanced <at ...> too
    .replace(/[<>]/g, '')                    // no stray angle brackets in plain_text
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function truncateCardText(s: string, max = 800): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function sidebarUrl(url: string): string {
  const qs = new URLSearchParams({
    mode: 'sidebar-semi',
    min_width: '350',
    width: '800',
    max_width: '1200',
    reload: 'false',
    url,
  });
  return `https://applink.feishu.cn/client/web_url/open?${qs.toString()}`;
}

function sidebarMultiUrl(url: string): Record<string, string> {
  const pcUrl = sidebarUrl(url);
  return {
    url: pcUrl,
    pc_url: pcUrl,
    android_url: url,
    ios_url: url,
  };
}

function directMultiUrl(url: string): Record<string, string> {
  return {
    url,
    pc_url: url,
    android_url: url,
    ios_url: url,
  };
}

/** Shared terminal multi-url behavior for streaming and dashboard cards. */
export function terminalMultiUrl(url: string): Record<string, string> {
  return readGlobalConfig().dashboard?.openTerminalInFeishu === true
    ? sidebarMultiUrl(url)
    : directMultiUrl(url);
}

/** 💻「打开 <CLI>」默认隐藏，通过 dashboard.enableLocalCliOpen 显式开启：
 *  1) 当前 iTerm-first opener 只支持 macOS；生产 daemon 常跑在 headless Linux，
 *     即使误开开关也不能生成一个必然失败的按钮。
 *  2) `attach` 模式只在当前 backend 有精确 attach 目标时显示，尽量保持同一路 I/O/历史；
 *     `resume` 模式才要求 CLI direct resume readiness，且可能破坏飞书连续性。
 *
 *  localCliReady 必须由调用方按当前配置模式计算；handler 也会重复校验，防止已发出的
 *  旧卡片绕过开关或模式切换。 */
function localCliButton(
  cliId: CliId,
  actionBase: Record<string, string>,
  locale: Locale | undefined,
  localCliReady: boolean,
  runtimeDisplayName?: string,
): any | undefined {
  if (!isLocalCliOpenEnabled() || !localCliReady) return undefined;
  const cliName = runtimeDisplayName?.trim() || getCliDisplayName(cliId);
  // Keep existing official/legacy labels byte-for-byte. A configured runtime
  // uses the generic interpolated label so the button names what it launches.
  const labelKey = runtimeDisplayName?.trim()
    ? 'card.btn.open_local_cli'
    : cliId === 'codex'
      ? 'card.btn.open_local_codex'
      : cliId === 'traex'
        ? 'card.btn.open_local_trae'
        : 'card.btn.open_local_cli';
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: t(labelKey, { cliName }, locale) },
    type: 'default',
    value: { action: 'open_local_cli', ...actionBase },
  };
}

/**
 * Build a Feishu interactive card with terminal button + action buttons.
 * @param showManageButtons - When true, include restart & close buttons (used in the private write-link card — delivered as a "visible-to-you" ephemeral card in plain groups, or DM'd as fallback).
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
  localCliReady = false,
  runtimeDisplayName?: string,
): string {
  const cliName = runtimeDisplayName?.trim() || getCliDisplayName(cliId ?? 'claude-code');
  const effectiveCliId = cliId ?? 'claude-code';
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: effectiveCliId };
  const actions: any[] = [];
  if (terminalUrl) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t(showManageButtons ? 'card.btn.open_writable_terminal' : 'card.btn.open_terminal', undefined, locale) },
      type: 'primary',
      multi_url: terminalMultiUrl(terminalUrl),
    });
  }
  if (!showManageButtons) {
    const localBtn = cliId ? localCliButton(effectiveCliId, actionBase, locale, localCliReady, runtimeDisplayName) : undefined;
    if (localBtn) actions.push(localBtn);
    if (terminalUrl) {
      actions.push({
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.btn.get_write_link', undefined, locale) },
        type: 'default',
        value: { action: 'get_write_link', ...actionBase },
      });
    }
  }
  // No restart button for ANY remote CLI: the riff worker refuses the IPC
  // (dead button), and the mojo worker EXECUTES it — cancelling the remote
  // session and cold-booting a context-less replacement. The riff-only literal
  // rendered a live remote-destruction button on mojo cards (fourth-round
  // review, gate 1); the click handler also guards, this keeps the surface
  // honest.
  if (showManageButtons && !adoptMode && !isRemoteCliId(effectiveCliId)) {
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
      title: { tag: 'plain_text', content: `🖥️ ${cliName} · ${plainTitle(title)}` },
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
 * a specific session from CLI args (gemini's "latest only") surface a
 * fallback note instead of a fake command.
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
  runtimeDisplayName?: string,
  resumeStartsFresh?: boolean,
): string {
  const cliName = runtimeDisplayName?.trim() || getCliDisplayName(cliId ?? 'claude-code');
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: cliId ?? 'claude-code' };
  const dirLine = workingDir ? `\n${t('card.body.working_dir', undefined, locale)}\`${escapeMd(workingDir)}\`` : '';
  const cmdBlock = cliResumeCommand
    ? `${t('card.body.click_resume_or_run', undefined, locale)}\n\`\`\`\n${cliResumeCommand}\n\`\`\``
    : resumeStartsFresh
      // The CLI can only resume a precise session id and none was persisted:
      // resuming reactivates the topic's message route, but the next spawn
      // starts a FRESH session — say so instead of implying history is back.
      ? t('card.body.resume_starts_fresh', { cliName: escapeMd(cliName) }, locale)
      : `${t('card.body.click_resume_only', undefined, locale)}\n${t('card.body.cli_no_cli_resume', { cliName: escapeMd(cliName) }, locale)}`;
  const body =
    `**${escapeMd(title || cliName)}**\n` +
    `${t('card.body.cli_terminated', { cliName: escapeMd(cliName) }, locale)}${cmdBlock}` +
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

/** Parent-topic panel for `/fork <task>`. Links and live/closed state are
 *  resolved by the command layer; this function only renders the card. */
export function buildForkPanelCard(
  children: Array<{ instruction: string; status: 'active' | 'closed'; link: string }>,
  locale?: Locale,
): string {
  if (children.length === 0) {
    return JSON.stringify({
      schema: '2.0',
      config: { update_multi: true },
      header: {
        template: 'purple',
        title: { tag: 'plain_text', content: t('card.fork_panel.title', undefined, locale) },
      },
      body: {
        direction: 'vertical',
        elements: [{ tag: 'markdown', content: t('card.fork_panel.empty', undefined, locale) }],
      },
    });
  }

  const rows = children.map(child => ({
    instruction: child.instruction.replace(/\s*\n+\s*/g, ' ').slice(0, 300) || '—',
    status: child.status === 'active'
      ? t('card.fork_panel.running', undefined, locale)
      : t('card.fork_panel.done', undefined, locale),
    link: `[${t('card.fork_panel.goto', undefined, locale)}](${child.link})`,
  }));
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'purple',
      title: { tag: 'plain_text', content: t('card.fork_panel.title', undefined, locale) },
    },
    body: {
      direction: 'vertical',
      elements: [{
        tag: 'table',
        page_size: 10,
        row_height: 'low',
        header_style: {
          text_align: 'left',
          text_size: 'normal',
          background_style: 'grey',
          text_color: 'default',
          bold: true,
          lines: 1,
        },
        columns: [
          { name: 'instruction', display_name: t('card.fork_panel.col_instruction', undefined, locale), data_type: 'text', width: 'auto' },
          { name: 'status', display_name: t('card.fork_panel.col_status', undefined, locale), data_type: 'text', width: '90px' },
          { name: 'link', display_name: t('card.fork_panel.col_link', undefined, locale), data_type: 'lark_md', width: '90px' },
        ],
        rows,
      }],
    },
  });
}

/** Collapse whitespace and clip a discovered-command description for a table cell. */
function clipDesc(desc?: string): string {
  if (!desc) return '—';
  const flat = desc.replace(/\s+/g, ' ').trim();
  return flat.length > 70 ? flat.slice(0, 69) + '…' : flat;
}

/**
 * Build the `/list-slash-command` card (schema 2.0): a coloured header and four
 * sections — ① fixed passthrough allowlist, ② adapter-default passthrough,
 * ③ user-configured custom passthrough, ④ auto-discovered CLI commands/skills/plugins
 * rendered as a paginated native table (command | description). An optional MCP
 * servers note is appended.
 */
export function buildSlashListCard(
  params: {
    cliName: string;
    builtin: string[];
    adapterDefaults?: string[];
    custom: string[];
    discovered: { name: string; description?: string }[];
    workingDir: string;
    mcpServers: string[];
    discoverySupported?: boolean;
  },
  locale?: Locale,
): string {
  const { cliName, builtin, adapterDefaults = [], custom, discovered, workingDir, mcpServers, discoverySupported = true } = params;
  const asCode = (cmds: string[]) => cmds.map((c) => `\`${c}\``).join('  ');
  const elements: any[] = [];

  // ① 固定放行（内置透传白名单）
  elements.push({
    tag: 'markdown',
    content: `**${t('slashlist.part_builtin', undefined, locale)}**\n${builtin.length ? asCode(builtin) : '—'}`,
  });
  elements.push({ tag: 'hr' });

  // ② 当前 CLI adapter 默认透传
  elements.push({
    tag: 'markdown',
    content: `**${t('slashlist.part_adapter', undefined, locale)}**\n${adapterDefaults.length ? asCode(adapterDefaults) : '—'}`,
  });
  elements.push({ tag: 'hr' });

  // ③ 用户自定义配置
  elements.push({
    tag: 'markdown',
    content: `**${t('slashlist.part_custom', undefined, locale)}**\n${
      custom.length ? asCode(custom) : t('slashlist.part_custom_empty', undefined, locale)
    }`,
  });
  elements.push({ tag: 'hr' });

  // ④ 自动发现（命令 / skill / 插件）
  const markdownCliName = escapeMd(cliName);
  const discHeading = `**${t('slashlist.part_discovered', { cliName: markdownCliName }, locale)}**`;
  if (!discoverySupported) {
    elements.push({
      tag: 'markdown',
      content: `${discHeading}\n${t('slashlist.part_discovered_unsupported', { cliName: markdownCliName }, locale)}`,
    });
  } else if (discovered.length === 0) {
    elements.push({
      tag: 'markdown',
      content: `${discHeading}\n${t('slashlist.part_discovered_empty', { dir: workingDir }, locale)}`,
    });
  } else {
    const MAX = 60;
    const shown = discovered.slice(0, MAX);
    elements.push({ tag: 'markdown', content: `${discHeading}　·　${discovered.length}` });
    elements.push({
      tag: 'table',
      page_size: 10,
      row_height: 'low',
      header_style: {
        text_align: 'left',
        text_size: 'normal',
        background_style: 'grey',
        text_color: 'default',
        bold: true,
        lines: 1,
      },
      columns: [
        { name: 'cmd', display_name: t('slashlist.col_cmd', undefined, locale), data_type: 'lark_md', width: '200px' },
        { name: 'desc', display_name: t('slashlist.col_desc', undefined, locale), data_type: 'text', width: 'auto' },
      ],
      rows: shown.map((c) => ({ cmd: `\`${c.name}\``, desc: clipDesc(c.description) })),
    });
    if (discovered.length > MAX) {
      // schema 2.0 卡片已不支持 note 标签（飞书 ErrCode 200861），改用 markdown 元素
      elements.push({
        tag: 'markdown',
        content: t('slashlist.more', { n: String(discovered.length - MAX) }, locale),
      });
    }
  }

  // MCP 提示（server 名，prompt 需运行时握手不在此列）
  if (mcpServers.length > 0) {
    elements.push({ tag: 'hr' });
    // schema 2.0 卡片已不支持 note 标签（飞书 ErrCode 200861），改用 markdown 元素
    elements.push({
      tag: 'markdown',
      content: t('slashlist.mcp_note', { servers: mcpServers.join(', ') }, locale),
    });
  }

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('slashlist.heading', { cliName }, locale) },
    },
    body: { direction: 'vertical', elements },
  });
}


export function buildDetouredPendingResponseCard(locale?: Locale): string {
  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    header: {
      template: 'grey',
      title: { tag: 'plain_text', content: t('card.pending.detoured_title', undefined, locale) },
    },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: t('card.pending.detoured_body', undefined, locale) },
      ],
    },
  });
}

/**
 * Build a frozen-snapshot card to PATCH onto the source-chat streaming card
 * after `/relay` moves the session elsewhere.
 *
 * Why this exists: a live streaming card carries action buttons (close /
 * toggle display / get write link). Those buttons identify their session by
 * `session_id` in the value payload, so clicking them after relay still
 * reaches the now-relocated session — closing it, toggling its display
 * mode, etc. — but the visible feedback all lands on the NEW card in the
 * target chat, not this one. The source-chat card then looks like a "live
 * console" while actually being a footgun. PATCH it to an inert snapshot
 * so the user sees clearly it's historical.
 *
 * Last-frame rendering:
 *   - imageKey present (session was in 'screenshot' / expanded mode at
 *     relay time) → embed the same img element the live card had.
 *     img_key is a Lark server resource independent of the card it lived
 *     on, so the PATCHed card can still reference it.
 *   - imageKey absent (hidden / collapsed mode) → render nothing extra.
 *     The header + body notice already convey the state; raw tmux pane
 *     text as a code-block is too long and noisy (王皓 caught this in
 *     testing).
 *
 * No action buttons are rendered in either case.
 */
export function buildRelayedFrozenCard(
  title: string,
  cliId?: CliId,
  imageKey?: string,
  locale?: Locale,
): string {
  const cliName = getCliDisplayName(cliId ?? 'claude-code');
  const body =
    `**${escapeMd(title || cliName)}**\n` +
    `${t('card.body.relay_frozen', undefined, locale)}`;
  const elements: any[] = [
    { tag: 'markdown', content: body },
  ];
  if (imageKey) {
    elements.push({
      tag: 'img',
      img_key: imageKey,
      alt: { tag: 'plain_text', content: '' },
      mode: 'fit_horizontal',
      preview: true,
    });
  }
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.status.relay_frozen', undefined, locale) },
      template: 'grey',
    },
    elements,
  };
  return JSON.stringify(card);
}

/**
 * Feishu card API rejects payloads exceeding ~109 KB (error 230025).
 * Cap markdown content byte size with headroom for card JSON overhead.
 */
const MAX_CONTENT_BYTES = 100_000;

/**
 * Truncate content to fit within `maxBytes`, keeping the tail (most recent
 * output). Defaults to {@link MAX_CONTENT_BYTES}; callers that wrap the content
 * in additional card JSON (e.g. the private snapshot's code fence) pass a
 * tighter budget so the whole card stays under Feishu's ~109 KB hard limit.
 */
export function truncateContent(content: string, locale?: Locale, maxBytes: number = MAX_CONTENT_BYTES): string {
  if (Buffer.byteLength(content, 'utf-8') <= maxBytes) return content;
  // Binary search for the longest suffix that fits
  const lines = content.split('\n');
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = lines.slice(mid).join('\n');
    if (Buffer.byteLength(candidate, 'utf-8') <= maxBytes - 30) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return `${t('card.status.truncated_prefix', undefined, locale)}\n${lines.slice(lo).join('\n')}`;
}

/** Byte budget for the private snapshot's text fallback. Well under the ~109 KB
 *  card limit, leaving room for JSON escaping + the card's structural overhead. */
const PRIVATE_SNAPSHOT_TEXT_MAX = 50_000;

const STREAM_TEMPLATE_MAP = {
  starting: 'yellow', working: 'blue', idle: 'green', analyzing: 'purple', stalled: 'red', limited: 'red', retry_ready: 'green', interrupted: 'orange',
} as const;

/** Header status label for a streaming/snapshot card. Shared by the live card
 *  and the private snapshot so the two never drift. */
function streamStatusLabel(status: StreamStatus, usageLimit: CliUsageLimitState | undefined, locale?: Locale, silentIdle?: boolean): string {
  switch (status) {
    case 'starting': return t('card.status.starting', undefined, locale);
    case 'working': return t('card.status.working', undefined, locale);
    // silentIdle: the turn completed as DELIBERATE silence (bare
    // nothing-to-send sentinel). Plain 「等待输入」 here is indistinguishable
    // from a hung session; say "handled, judged no reply needed" instead.
    case 'idle': return t(silentIdle ? 'card.status.idle_silent' : 'card.status.idle', undefined, locale);
    case 'analyzing': return t('card.status.analyzing', undefined, locale);
    case 'stalled': return t('card.status.stalled', undefined, locale);
    case 'limited': return usageLimit?.retryReady
      ? t('card.status.retry_ready', undefined, locale)
      : t('card.status.limited', undefined, locale);
    case 'interrupted': return t('card.status.interrupted', undefined, locale);
  }
}

/** Push the shared "output body" elements (usage-limit notice + screenshot) used
 *  by both {@link buildStreamingCard} and {@link buildPrivateSnapshotCard}. */
function pushStreamBody(
  elements: any[],
  opts: { status: StreamStatus; usageLimit?: CliUsageLimitState; displayMode: DisplayMode; imageKey?: string; cliName: string; locale?: Locale; usage?: CardUsageSnapshot },
): void {
  const { status, usageLimit, displayMode, imageKey, cliName, locale, usage } = opts;
  if (status === 'limited' && usageLimit) {
    elements.push({
      tag: 'markdown',
      content: usageLimit.retryReady
        ? t('card.usage_limit.retry_ready', { cliName: escapeMd(cliName) }, locale)
        : t('card.usage_limit.retry_at', { cliName: escapeMd(cliName), retryLabel: usageLimit.retryLabel }, locale),
    });
    elements.push({ tag: 'hr' });
  }
  if (displayMode === 'screenshot') {
    if (imageKey) {
      elements.push({ tag: 'img', img_key: imageKey, alt: { tag: 'plain_text', content: '' }, mode: 'fit_horizontal', preview: true });
    } else {
      elements.push({ tag: 'markdown', content: t('card.status.waiting_screenshot', undefined, locale) });
    }
    elements.push({ tag: 'hr' });
  }
  // Native Context / Token usage line (grey, small) when this bot displays usage
  // on the streaming card. Missing metrics are omitted independently by
  // cardUsageFooterSegment; a fully-empty snapshot renders nothing.
  const usageSeg = usage
    ? cardUsageFooterSegment(usage, locale, 'streaming', { compactHintThreshold: contextCompactThreshold() })
    : null;
  if (usageSeg) {
    // Usage metrics + runtime identity render as ONE single-line text run in a
    // single markdown element, joined by ` · ` — not a two-column split. This
    // reads as "one row": when the content is short it's literally one line;
    // when it's long it wraps as the CONTINUOUS FLOW of one paragraph, never as
    // two mis-aligned columns (the column_set variants left the runtime floating
    // on a second line / left-anchored on mobile, which the user found jarring).
    // The trade-off the user accepted: on a long line the runtime is not pinned
    // to the right edge — it simply follows the metrics in reading order. The
    // runtime self-truncates (model ≤20 chars) so the tail stays compact. No
    // runtime → the metrics render alone, unchanged.
    const runtimeSeg = usage ? cardUsageRuntimeSegment(usage, true) : null;
    const line = runtimeSeg ? `${usageSeg} · ${runtimeSeg}` : usageSeg;
    // 上下文吃紧时整行转红（而不是另起一行报警）：提示就在用量数字旁边，一眼可见，
    // 且不多占卡片高度。判据与 footer 里追加「建议压缩」的**是同一个谓词**——刻意不去
    // 嗅 usageSeg 里有没有那串提示文案：那份文案是可被用户自定义覆盖的（覆盖成空串时
    // `includes('')` 恒真 ⟹ 每张卡都会变红），且把颜色行为耦合到文案上会让「改个翻译」
    // 静默改掉配色。
    const overThreshold = !!usage && contextOverCompactThreshold(usage, contextCompactThreshold());
    elements.push({
      tag: 'markdown',
      text_size: 'notation_small_v2',
      content: `<font color='${overThreshold ? 'red' : 'grey'}'>${line}</font>`,
    });
  }
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
  writableTerminalUrl?: string,
  localCliReady = false,
  usage?: CardUsageSnapshot,
  runtimeDisplayName?: string,
  serviceTierBadge?: string,
  silentIdle?: boolean,
  /** Live per-bot `dshRuntime`. Only meaningful for cliId 'dsh': 'tui' means the
   *  worker spawns the PTY-driven dsh-tui adapter (a real interactive TUI that
   *  accepts a raw /compact), so the compact button must stay visible. Omitted ⇒
   *  fail-closed to the headless JSON-RPC runner, which matches this card's
   *  pre-existing behaviour for dsh (no transcript ⇒ the old percentage gate
   *  never showed the button either), so a call site that forgets to pass it
   *  degrades to the status quo rather than to a broken button. */
  dshRuntime?: 'official' | 'tui',
): string {
  const effectiveCliId = cliId ?? 'claude-code';
  const cliName = runtimeDisplayName?.trim() || getCliDisplayName(effectiveCliId);
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: effectiveCliId, ...(cardNonce ? { card_nonce: cardNonce } : {}) };
  const displayStatus = status === 'limited' && usageLimit?.retryReady ? 'retry_ready' : status;

  const elements: any[] = [];

  // ── Output body (shared with the private snapshot card) ──────────────────
  pushStreamBody(elements, { status, usageLimit, displayMode, imageKey, cliName, locale, usage });

  // ── 上下文余量：**不再单独渲染一行** ────────────────────────────────────
  // 曾经这里 push 过一行 `📊 上下文 N%`，但卡片下方本来就有 usage footer
  // （md-card.ts 的 cardUsageFooterSegment，streaming 变体）在渲染
  // `上下文 34.3K/258.4K (13%) · 累计 … · 模型`——两者**同源**（都读
  // usage.context.percentUsed），于是同一个百分比在一张卡上出现两次，而这一行还
  // 比 footer 少了绝对值。唯一不冗余的是「超阈值提醒」，已折进 footer 那一行
  // （见 cardUsageFooterSegment 的 compactHintThreshold）。

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
  if (terminalUrl) {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.open_terminal', undefined, locale) },
      type: 'primary',
      multi_url: terminalMultiUrl(terminalUrl),
    });
  }
  const localBtn = cliId ? localCliButton(effectiveCliId, actionBase, locale, localCliReady, runtimeDisplayName) : undefined;
  if (localBtn) headerActions.push(localBtn);
  if (status === 'limited' && usageLimit?.retryReady) {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.retry_last_task', undefined, locale) },
      type: 'primary' as const,
      value: { action: 'retry_last_task', ...actionBase },
    });
  }
  if (terminalUrl) {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.get_write_link', undefined, locale) },
      type: 'default',
      value: { action: 'get_write_link', ...actionBase },
    });
  }
  // 「🗜️ 压缩」：只要该 CLI 有能接收 /compact 的输入通道就显示——**不再要求有上下文
  // 百分比**。此前条件是 hasContextPct，但只有 codex（native model_context_window）和
  // pi（读 ~/.pi/agent/models.json）算得出百分比；Claude Code 的 transcript 里根本没有
  // 上下文窗口字段（只有 model），于是 Claude 会话永远看不到压缩按钮——而 Claude 恰好
  // 是最需要 /compact 的一家。百分比是「快满了吗」的提示，与「能不能压缩」无关，用它当
  // 闸门是拿错了判据。
  //
  // 判据必须**调谓词**（cliHasNoRawPassthroughSurface），不能手写单个 cliId 字面量：
  //   ① remote CLI（riff/mojo）无本地终端可驱动；
  //   ② 无 raw passthrough 面的 CLI（codex-app/mira/mir/dsh/ebsd）——/compact 走 raw_input
  //      把字面量写进 PTY，绕过 runner 的 `::botmux-<id>:<base64>` 帧协议：dsh 打
  //      `ignoring non-frame input` 静默丢弃，mira/mir 把 `/compact` 当**普通用户消息**
  //      发给模型白烧一个 turn。打字发 /compact 本就被 router 的
  //      resolvePassthroughCommands 对这些 CLI 返回空集拦住，按钮不能把那条路重新打开。
  // dsh 是运行时相关的：dshRuntime='tui' 跑的是 PTY 驱动的 dsh-tui（真交互 TUI），照常显示。
  // handler 侧另有一道同谓词的拒绝兜底（compact_session），两层都不依赖百分比。
  if (!isRemoteCliId(cliId) && !cliHasNoRawPassthroughSurface(effectiveCliId, { dshRuntime })) {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.compact', undefined, locale) },
      type: 'default' as const,
      value: { action: 'compact_session', ...actionBase },
    });
  }
  // 「⏹ 停止」：常驻主控制行（不再受 displayMode==='hidden' 折叠态限制——折叠态是 turn
  // 跑飞时用户唯一可见的一行，此前只能 /close 杀整个会话丢上下文）。点击走已有的
  // term_action ctrlc IPC 链路（与展开态 ^C 快捷键完全同款），中断当前 turn 但保留会话。
  // 仅在有 turn 可停的状态显示：idle 无 turn 可停；starting CLI 未起；limited turn 已失败。
  // remote CLI（riff/mojo）无终端可驱动、codex-app 无 PTY 输入通道，均隐藏。
  if (!isRemoteCliId(cliId) && effectiveCliId !== 'codex-app'
    && (status === 'working' || status === 'analyzing' || status === 'stalled')) {
    headerActions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.stop', undefined, locale) },
      type: 'default' as const,
      value: { action: 'stop_turn', ...actionBase },
    });
  }
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

  // ── Writable terminal link (opt-in) ─────────────────────────────────────
  // When the bot enables `writableTerminalLinkInCard`, embed the token-bearing
  // link right in the card so anyone here can open a writable terminal without
  // the get-write-link → DM round-trip. The link is intentionally group-visible.
  // Rendered as a URL button (same shape as the read-only terminal button),
  // not a markdown link: the token URL is long and wrapped into an ugly raw
  // URL blob in the card. The group-visible warning stays as a note below.
  if (writableTerminalUrl) {
    elements.push({
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.btn.open_writable_terminal', undefined, locale) },
        type: 'primary',
        multi_url: terminalMultiUrl(writableTerminalUrl),
      }],
    });
    elements.push({
      tag: 'note',
      elements: [{
        tag: 'lark_md',
        content: t('card.writable_terminal_warning', undefined, locale),
      }],
    });
  }

  // ── Quick-action keys (only when the screenshot is visible — in text mode
  //    there's no visible cursor/input, so these keys would fire blindly) ──
  // 远端任务后端（riff / mojo）没有可驱动的终端，PTY 快捷键只会变成内容为控制
  // 字符的 follow-up 任务（worker 侧也有同款拒绝守卫），整排隐藏。
  // 用 isRemoteCliId 而非硬编码单个 id：这一处原本只排除了 riff，于是新增 mojo
  // 后卡片照旧渲染 11 个按钮、点击全部静默无效；改走 REMOTE_CLI_IDS 单一事实源，
  // 以后再加远端 CLI 不会重复漏改。
  if (displayMode === 'screenshot' && !isRemoteCliId(cliId)) {
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
      title: { tag: 'plain_text', content: `🖥️ ${cliName}${serviceTierBadge ? ` ${serviceTierBadge}` : ''} · ${plainTitle(title)} — ${streamStatusLabel(status, usageLimit, locale, silentIdle)}` },
      template: STREAM_TEMPLATE_MAP[displayStatus],
    },
    elements,
  };
  return JSON.stringify(card);
}

/**
 * Build a static "private snapshot" card for `/card` in private mode — sent via
 * the ephemeral API to one user at a time. Unlike {@link buildStreamingCard} it
 * is **never PATCH-updated** (ephemeral cards can't be), so it carries only a
 * one-shot snapshot of the terminal screenshot plus controls:
 *   • when available, a read-only "open terminal" link and "get write link";
 *   • "close session", whose callback kills the session and (in private mode)
 *     sends the "closed" card ephemeral to the owner audience too — so the
 *     session title / CLI name / workingDir on it don't leak to the group.
 * The last two have callbacks but neither patches THIS card (one DMs, the other
 * sends a fresh card), so both work fine on an ephemeral card. Both are
 * `canOperate`-gated in the handler — talk-only viewers who tap them are denied.
 * The patch-driven controls (toggle/refresh/export/term keys) and the inline
 * writable link are still omitted: those need to update this card, which
 * ephemeral cards can't do.
 */
export function buildPrivateSnapshotCard(
  terminalUrl: string,
  title: string,
  status: StreamStatus,
  cliId: CliId | undefined,
  imageKey: string | undefined,
  screenContent: string,
  sessionId: string,
  rootId: string,
  locale?: Locale,
  usageLimit?: CliUsageLimitState,
  runtimeDisplayName?: string,
): string {
  const effectiveCliId = cliId ?? 'claude-code';
  const cliName = runtimeDisplayName?.trim() || getCliDisplayName(effectiveCliId);
  const displayStatus = status === 'limited' && usageLimit?.retryReady ? 'retry_ready' : status;
  // `visibility: 'private'` pins this card's privacy intent onto the action
  // itself, so a later callback (notably `close`) keeps sending ephemeral even
  // if the bot's `privateCard` config is toggled off after the card was sent —
  // otherwise the closed card (session title / workingDir / resume command)
  // could leak to the group. See the `close` handler in card-handler.ts.
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: effectiveCliId, visibility: 'private' as const };

  const elements: any[] = [];
  // Show the terminal once: prefer the rendered screenshot when present;
  // otherwise fall back to a code-block of the latest screen text so the
  // snapshot isn't empty (common when the bot has the streaming card disabled
  // or display mode never flipped to screenshot — `lastScreenContent` is still
  // kept up to date regardless). pushStreamBody also emits the usage-limit
  // notice, which applies in either case.
  pushStreamBody(elements, {
    status, usageLimit, displayMode: imageKey ? 'screenshot' : 'hidden', imageKey, cliName, locale,
  });
  if (!imageKey) {
    const text = (screenContent ?? '').replace(/[ \t\r\n]+$/, '');
    if (text) {
      const body = truncateContent(text, locale, PRIVATE_SNAPSHOT_TEXT_MAX);
      // Fence must be longer than the longest backtick run in the body, else
      // terminal output containing ``` would break out of the code block.
      const maxRun = (body.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
      const fence = '`'.repeat(Math.max(3, maxRun + 1));
      elements.push({ tag: 'markdown', content: `${fence}\n${body}\n${fence}` });
      elements.push({ tag: 'hr' });
    }
  }

  const actions: any[] = [];
  if (terminalUrl) {
    actions.push(
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.btn.open_terminal', undefined, locale) },
        type: 'primary',
        multi_url: terminalMultiUrl(terminalUrl),
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: t('card.btn.get_write_link', undefined, locale) },
        type: 'default',
        value: { action: 'get_write_link', ...actionBase },
      },
    );
  }
  actions.push({
    tag: 'button',
    text: { tag: 'plain_text', content: t('card.btn.close_session', undefined, locale) },
    type: 'danger',
    value: { action: 'close', ...actionBase },
  });
  elements.push({ tag: 'action', actions });
  elements.push({
    tag: 'note',
    elements: [{
      tag: 'lark_md',
      content: t(terminalUrl ? 'card.private.snapshot_note' : 'card.private.snapshot_note_no_terminal', undefined, locale),
    }],
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `🔒 ${cliName} · ${plainTitle(title)} — ${streamStatusLabel(status, usageLimit, locale)}` },
      template: STREAM_TEMPLATE_MAP[displayStatus],
    },
    elements,
  };
  return JSON.stringify(card);
}

/**
 * Build a Feishu interactive card with a dropdown selector for projects.
 * Returns a JSON string suitable for msg_type: 'interactive'.
 */
/** The worktree multi-select form element (multi_select + branch input + submit),
 *  inlined into the repo card when the bot is in multi-repo-picker mode. */
function worktreeMultiForm(worktreeOptions: Array<{ text: { tag: 'plain_text'; content: string }; value: string }>, rootMessageId?: string, locale?: Locale): any {
  return {
    tag: 'form',
    name: 'repo_worktree_submit_form',
    elements: [
      {
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'default',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 2, vertical_align: 'center',
            elements: [{
              tag: 'multi_select_static',
              name: 'repo_worktree_paths',
              required: true,
              width: 'fill',
              placeholder: { tag: 'plain_text', content: t('card.repo.placeholder_worktree_multi', undefined, locale) },
              options: worktreeOptions,
            }],
          },
          {
            tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
            elements: [{
              tag: 'input',
              name: 'repo_worktree_branch',
              placeholder: { tag: 'plain_text', content: t('card.repo.worktree_branch_placeholder', undefined, locale) },
            }],
          },
          {
            tag: 'column', width: 'auto', vertical_align: 'center',
            elements: [{
              tag: 'button',
              name: 'repo_worktree_submit',
              text: { tag: 'plain_text', content: t('card.btn.worktree_repo', undefined, locale) },
              type: 'default',
              action_type: 'form_submit',
              value: { action: 'repo_worktree_submit', root_id: rootMessageId ?? '' },
            }],
          },
        ],
      },
    ],
  };
}

/** Repo selection card. `multiPicker` (persisted per-bot via worktreeMultiPicker)
 *  flips the worktree control between an instant single-select dropdown (false)
 *  and the inline multi-select form (true). */
export function buildRepoSelectCard(projects: ProjectInfo[], currentPath?: string, rootMessageId?: string, locale?: Locale, multiPicker?: boolean): string {
  const currentMarker = t('card.repo.current_marker', undefined, locale);
  const options = projects.map((p, i) => {
    const currentTag = p.path === currentPath ? currentMarker : '';
    const typeTag = p.type === 'worktree' ? ' [worktree]' : '';
    return {
      text: { tag: 'plain_text' as const, content: `${i + 1}. ${p.name} (${p.branch})${typeTag}${currentTag}` },
      value: p.path,
    };
  });

  // Second dropdown: open a repo as a NEW worktree (branched off its remote
  // default branch). Only main checkouts make sense as sources — existing
  // worktrees of the same repo would just duplicate the list.
  const worktreeOptions = projects
    .filter(p => p.type === 'repo')
    .map(p => ({
      text: { tag: 'plain_text' as const, content: `${p.name} (${p.branch})` },
      value: p.path,
    }));

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('card.repo.title', undefined, locale) },
    },
    elements: [
      // Current working directory + 「直接开启会话」on the same row: the skip
      // button means "use this directory as-is, don't pick a repo", so it pairs
      // with the current-dir line rather than the switch dropdown below.
      {
        tag: 'column_set',
        // flow: columns sit side-by-side on desktop and reflow (button wraps
        // below) on narrow mobile instead of squeezing the button until its
        // label truncates. auto-width columns size to content, so the text and
        // button hug each other (no wide desktop gap) and the button always
        // shows its full label.
        flex_mode: 'flow',
        horizontal_spacing: 'default',
        columns: [
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: `${t('card.repo.current_active', undefined, locale)}**${escapeMd(currentPath ?? 'N/A')}**`,
                },
              },
            ],
          },
          {
            tag: 'column',
            width: 'auto',
            vertical_align: 'center',
            elements: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: t('card.btn.skip_repo', undefined, locale) },
                type: 'primary',
                value: { action: 'skip_repo', root_id: rootMessageId ?? '' },
              },
            ],
          },
        ],
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
        ],
      },
      // Worktree open. Two modes, persisted per-bot (worktreeMultiPicker):
      //   • single (default) — instant single-select dropdown + a short 「🔀 多仓库」
      //     button on the SAME action row (a select_static can't live in a
      //     column_set, so it can't be weight-filled like the manual input; a short
      //     a column_set so the dropdown weight-fills and the toggle button hugs
      //     the right edge — same row, same alignment as the manual-entry row,
      //     and it never wraps on mobile (the column_set forces one line). A
      //     select_static CAN live in a column_set (it renders + fires); only the
      //     `action` *container* tag is rejected inside a column.
      //   • multi — the inline multi-select form, with a 「🔀 单仓库」toggle on its
      //     own right-aligned row below (the form already fills its row).
      // The toggle flips the persisted mode for all of this bot's future sessions
      // (only shown with 2+ main repos — batching a single repo is pointless).
      ...(worktreeOptions.length > 0 ? (multiPicker ? [
        worktreeMultiForm(worktreeOptions, rootMessageId, locale),
        ...(worktreeOptions.length > 1 ? [{
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: 'default',
          columns: [
            {
              tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
              elements: [{ tag: 'div', text: { tag: 'lark_md', content: t('card.repo.worktree_now_multi', undefined, locale) } }],
            },
            {
              tag: 'column', width: 'auto', vertical_align: 'center',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: t('card.btn.worktree_to_single', undefined, locale) },
                type: 'default',
                value: { action: 'worktree_toggle_mode', root_id: rootMessageId ?? '' },
              }],
            },
          ],
        }] : []),
      ] : [{
        tag: 'column_set',
        flex_mode: 'none',
        horizontal_spacing: 'default',
        columns: [
          {
            tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
            elements: [{
              tag: 'select_static',
              placeholder: { tag: 'plain_text', content: t('card.repo.placeholder_worktree', undefined, locale) },
              options: worktreeOptions,
              value: { key: 'repo_worktree', root_id: rootMessageId ?? '' },
            }],
          },
          ...(worktreeOptions.length > 1 ? [{
            tag: 'column', width: 'auto', vertical_align: 'center',
            elements: [{
              tag: 'button',
              text: { tag: 'plain_text', content: t('card.btn.worktree_to_multi', undefined, locale) },
              type: 'default',
              value: { action: 'worktree_toggle_mode', root_id: rootMessageId ?? '' },
            }],
          }] : []),
        ],
      }]) : []),
      // Manual entry: type any existing local directory the scan didn't surface
      // (mirrors `/repo <path>`). form_submit hands the input back under
      // value.action='repo_manual_submit' with form_value.repo_manual_path.
      {
        tag: 'form',
        name: 'repo_manual_form',
        elements: [
          // Input + 「使用此目录」on one row (column_set), mirroring the
          // dropdown+button rhythm above. form_submit still collects
          // form_value.repo_manual_path from the enclosing form.
          {
            tag: 'column_set',
            // flex_mode 'none' keeps the weighted input filling the row while
            // the auto-width button hugs its label — input stays usable on
            // mobile (not squeezed by a flow reflow) and the button never
            // truncates. (flow mode collapsed the input on narrow screens.)
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
                    tag: 'input',
                    name: 'repo_manual_path',
                    placeholder: { tag: 'plain_text', content: t('card.repo.manual_placeholder', undefined, locale) },
                  },
                ],
              },
              {
                tag: 'column',
                width: 'auto',
                vertical_align: 'center',
                elements: [
                  {
                    tag: 'button',
                    name: 'repo_manual_submit',
                    text: { tag: 'plain_text', content: t('card.btn.manual_repo', undefined, locale) },
                    type: 'default',
                    action_type: 'form_submit',
                    value: { action: 'repo_manual_submit', root_id: rootMessageId ?? '' },
                  },
                ],
              },
            ],
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
  /** 待授权目标，支持一次 /grant @a @b 多目标；owner 点一次范围对全部生效。 */
  targets: Array<{ openId: string; name: string }>;
  chatId: string;
  nonce: string;
  /** 'request' = 无权限者自助申请；'owner' = owner 主动 /grant。仅文案不同。 */
  mode: 'request' | 'owner';
  /** 当前卡片暂存的限制；缺省使用产品默认值。 */
  durationMs?: number;
  quota?: number;
}

/** 授权卡片：有效期与消息额度并列展示，owner 一次提交两项限制。 */
export function buildGrantCard(o: GrantCardOpts, locale?: Locale): string {
  const names = o.targets.map(t => `**${escapeMd(t.name)}**`).join('、');
  const single = o.targets[0];
  const body = o.mode === 'request'
    ? t('card.grant.body_request', { name: escapeMd(single?.name ?? ''), owner: o.ownerOpenId }, locale)
    : o.targets.length > 1
      ? t('card.grant.body_owner_multi', { names, owner: o.ownerOpenId }, locale)
      : t('card.grant.body_owner', { name: escapeMd(single?.name ?? ''), owner: o.ownerOpenId }, locale);
  const durationMs = o.durationMs ?? DEFAULT_GRANT_DURATION_MS;
  // 夹取到卡片可提交区间：历史 messageQuota.defaultLimit（parser 无上限）若 >MAX，
  // 直接透传会让初值超过 normalize 上限 → owner 一点授权就报「参数无效」发不出。
  const quota = clampGrantQuotaForCard(o.quota ?? DEFAULT_GRANT_QUOTA);
  // target_names 与 target_open_ids 同序：授权成功后据此把目标登记进 observed 花名册。
  const v = {
    target_open_ids: o.targets.map(t => t.openId),
    target_names: o.targets.map(t => t.name),
    chat_id: o.chatId,
    nonce: o.nonce,
    mode: o.mode,
  };
  const button = (action: string, text: string, type: string): Record<string, unknown> => ({
    tag: 'button',
    type,
    text: { tag: 'plain_text', content: text },
    name: action,
    // v2（schema 2.0）卡片的表单提交按钮用 action_type: 'form_submit'（与本文件其它 2.0 表单
    // 一致，也是本卡最初 live 验证过的写法）。曾一度改成 v2 的 form_action_type: 'submit'（见
    // 授权卡 UI 并排布局那次），实测点击授权按钮无任何反应——callback 不触发。故钉回 form_submit。
    action_type: 'form_submit',
    value: { action, ...v },
  });
  const grantButtons: Array<Record<string, unknown>> = [
    button('grant_chat', t('card.grant.btn_chat', undefined, locale), 'primary'),
  ];
  if (o.mode === 'owner') {
    grantButtons.push(button('grant_global', t('card.grant.btn_global', undefined, locale), 'default'));
  }
  grantButtons.push(button('grant_deny', t('card.grant.btn_deny', undefined, locale), 'danger'));
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: t('card.grant.title', undefined, locale) },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 20px 12px',
      vertical_spacing: 'medium',
      elements: [
        { tag: 'markdown', content: body },
        {
          tag: 'form',
          name: 'grant_limits_form',
          vertical_spacing: 'large',
          elements: [
            {
              tag: 'column_set',
              flex_mode: 'bisect',
              horizontal_spacing: 'medium',
              columns: [
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  vertical_spacing: 'small',
                  elements: [
                    {
                      tag: 'markdown',
                      content: `**${t('card.grant.duration_label', undefined, locale)}**`,
                    },
                    {
                      tag: 'select_static',
                      name: 'grant_duration',
                      width: 'fill',
                      initial_option: String(durationMs),
                      placeholder: { tag: 'plain_text', content: t('card.grant.duration_label', undefined, locale) },
                      options: [
                        ...GRANT_DURATION_OPTIONS.map(ms => ({
                          text: { tag: 'plain_text', content: t(`card.grant.duration_${ms}` as any, undefined, locale) },
                          value: String(ms),
                        })),
                        {
                          text: { tag: 'plain_text', content: t('card.grant.duration_permanent', undefined, locale) },
                          value: 'permanent',
                        },
                      ],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'weighted',
                  weight: 1,
                  vertical_spacing: 'small',
                  elements: [
                    {
                      tag: 'markdown',
                      content: `**${t('card.grant.quota_label', undefined, locale)}**`,
                    },
                    {
                      tag: 'input',
                      name: 'grant_quota',
                      width: 'fill',
                      default_value: quota === undefined ? '' : String(quota),
                      placeholder: { tag: 'plain_text', content: t('card.grant.quota_placeholder', undefined, locale) },
                    },
                  ],
                },
              ],
            },
            {
              tag: 'column_set',
              flex_mode: 'none',
              horizontal_spacing: 'small',
              columns: grantButtons.map(action => ({
                tag: 'column',
                width: 'auto',
                vertical_align: 'center',
                elements: [action],
              })),
            },
          ],
        },
        {
          tag: 'markdown',
          text_size: 'notation',
          content: `<font color="grey">${t('card.grant.note', undefined, locale)}</font>`,
        },
      ],
    },
  };
  return JSON.stringify(card);
}

/** 授权成功后给被授权人的通知卡（独立消息）。支持一次通知多个被授权人；带额度时追加"（额度 N 条）"。
 *
 *  **bot grantee 有名字就用纯文本名字、拿不到名字才 `<at>` 兜底；真人 grantee 一律 `<at>` 点名**：
 *  卡片里的 `<at id=botOpenId>` 会被对方 bot 的 daemon 当成一次「被 @」消息，凭新授权/同伴 peer
 *  关系在本群拉起一个空会话（实测：手动 /grant 后没有 prompt → 空会话「等待输入」）。所以能拿到
 *  bot 名字时优先用纯文本（不产生 mention、不唤醒对方）；只有名字缺失时才退回 `<at>`——此时飞书
 *  能据 open_id 展示对方身份（远比裸 open_id 可读），代价是可能偶尔触发一次空会话（产品上可接受，
 *  且名字缺失是少数边角情况）。真人被 `<at>` 不会自动开会话。传 string/string[]（无 isBot 信息）
 *  时按真人处理（@ 全部），保持旧调用方/单测兼容。 */
export function buildGrantNotifyCard(
  kind: 'chat' | 'global',
  target: string | string[] | Array<{ openId: string; name?: string; isBot?: boolean }>,
  locale?: Locale,
  quota?: number,
  expiresAt?: number,
): string {
  const entries = (Array.isArray(target) ? target : [target]).map(tt =>
    typeof tt === 'string' ? { openId: tt, name: undefined as string | undefined, isBot: false } : tt);
  const at = renderGrantAtMentions(entries);
  let content = t(kind === 'chat' ? 'card.grant.notify_chat' : 'card.grant.notify_global', { at }, locale);
  if (quota !== undefined && quota > 0) content += t('card.grant.notify_quota_suffix', { n: quota }, locale);
  if (expiresAt !== undefined) {
    content += t('card.grant.notify_expiry_suffix', { time: formatGrantExpiry(expiresAt, locale) }, locale);
  }
  const card = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
  };
  return JSON.stringify(card);
}

/** 额度用尽通知卡（@被授权人）：daemon 收回该 scope 授权后发到 session/线程。 */
export function buildQuotaExhaustedCard(targetOpenId: string, limit: number, locale?: Locale): string {
  const at = `<at id=${targetOpenId}></at>`;
  const content = t('quota.exhausted_notify', { at, limit }, locale);
  const card = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content } }],
  };
  return JSON.stringify(card);
}

/**
 * Reject card for `/adopt` (and Codex App / resume import) attempted while the
 * session is still on the first-spawn repo-select gate (`pendingRepo`). Adopt
 * attaches to an already-running CLI, so it cannot double as a way to finish
 * that gate: the two states are mutually exclusive by design. Rather than fold
 * the buffered repo-card messages into the takeover (complex + leaks botmux
 * envelopes into the external CLI), we refuse and offer a one-tap "close
 * session" so the user can retire the pending session and re-issue `/adopt`
 * cleanly. The close button reuses the shared `action: 'close'` handler; the
 * resulting closed card honours privateCard on its own.
 */
export function buildAdoptBlockedCard(rootId: string, sessionId: string, cliId: CliId | undefined, locale?: Locale): string {
  const actionBase = { root_id: rootId, session_id: sessionId, cli_id: cliId ?? 'claude-code' };
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.adopt_blocked.title', undefined, locale) },
      template: 'orange',
    },
    elements: [
      { tag: 'markdown', content: t('card.adopt_blocked.body', undefined, locale) },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.btn.close_session', undefined, locale) },
            type: 'danger',
            value: { action: 'close', ...actionBase },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}

export interface TurnFailedCardOpts {
  rootId: string;
  sessionId: string;
  cliId: CliId | undefined;
  cliName: string;
  /** `ambiguous` softens the title: the turn may have run, we just can't tell. */
  status: 'failed' | 'ambiguous';
  errorCode?: string;
  /** Human-safe failure summary from the CLI, when it provided one. */
  reason?: string;
  failedAt?: Date;
  /** The user's own prompt, for "which task was this". Truncated + escaped. */
  task?: string;
  /** Auto-continuation count, when a recovery ladder ran and gave up. */
  continuations?: number;
  /** Retry affordance, decided by `turnRetryOffer` — the handler enforces the
   *  same policy, so `none` must not render a button. */
  retryOffer: TurnRetryOffer;
  /** Pins the button to one specific failed turn; a stale card fails closed. */
  retryTurnId?: string;
  /** Human to @-mention in the body. Omitted → no mention (never @ a bot). */
  mentionOpenId?: string;
  terminalUrl?: string;
  locale?: Locale;
}

/** 通用失败卡：一条失败通知同时承载「现在什么情况」与「可以怎么办」。
 *
 *  取代原先的纯文本通知（`worker.ordinary_recovery_*` / `claude_terminal_failure_unrecovered`），
 *  并覆盖此前**完全静默**的 `ambiguous` 终态（CLI 崩溃 / 写入失败）——那类失败过去与
 *  「正常干完」在用户眼里同形。
 *
 *  三条刻意的设计约束：
 *  1. **errorCode 原样打出**。`ordinary_recovery_non_retryable` 是无条件兜底分支，
 *     daemon 重启这类非模型错误也会落到那句「不能安全自动续跑」；把码摊开才能让
 *     这种混淆可见，而不是继续被文案糊住。
 *  2. **重试的副作用风险必须写在卡上**。`caveated` 时明说「可能已执行了一部分」——
 *     `/retry` 是原样重发，不像自动续跑会带 checkpoint 提示。
 *  3. **@人只在正文**（`lark_md`）。`plain_text` 标题会被 {@link plainTitle} 剥掉
 *     `<at>`，放那儿等于不 @。 */
export function buildTurnFailedCard(o: TurnFailedCardOpts): string {
  const { locale } = o;
  const actionBase = {
    root_id: o.rootId,
    session_id: o.sessionId,
    cli_id: o.cliId ?? 'claude-code',
  };
  const titleKey = o.status === 'ambiguous'
    ? 'card.turn_failed.title_ambiguous'
    : 'card.turn_failed.title';

  const lines: string[] = [];
  // 先 @ 人再讲事：飞书的通知摘要只取前一段，@ 放最后会被截掉。
  if (o.mentionOpenId) lines.push(`<at id=${o.mentionOpenId}></at>`);
  // errorCode 是闭集常量（`cli_exit` / `provider_*` / `codexTaskFailureCode` 的
  // 固定返回值），从不携带 provider 原文，所以用反引号包成行内代码而不是
  // escapeMd —— 后者会把 `a_b_c` 里的下划线转义成可见的反斜杠，正是这类码最常
  // 见的形态。仍然剥掉反引号与尖括号，避免任何一天码变成动态值时逃出代码段。
  lines.push(t('card.turn_failed.field_error', {
    errorCode: `\`${(o.errorCode ?? o.status).replace(/[`<>]/g, '')}\``,
  }, locale));
  if (o.reason) {
    lines.push(t('card.turn_failed.reason', { reason: escapeMd(o.reason) }, locale));
  }
  if (o.failedAt) {
    lines.push(t('card.turn_failed.field_when', {
      when: o.failedAt.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { hour12: false }),
    }, locale));
  }
  if (o.task) {
    const trimmed = o.task.length > 80 ? `${o.task.slice(0, 80)}…` : o.task;
    lines.push(t('card.turn_failed.field_task', { task: escapeMd(trimmed) }, locale));
  }
  if (o.continuations !== undefined && o.continuations > 0) {
    lines.push(t('card.turn_failed.field_continuations', {
      count: String(o.continuations),
    }, locale));
  }

  const elements: any[] = [
    { tag: 'markdown', content: lines.join('\n') },
    { tag: 'hr' },
  ];

  // 重试建议与按钮由同一个 retryOffer 决定，避免「卡上说能重试但按钮不给」。
  const canRetry = o.retryOffer !== 'none' && !!o.retryTurnId;
  const adviceKey = o.retryOffer === 'none'
    ? 'card.turn_failed.no_retry'
    : !o.retryTurnId
      ? 'card.turn_failed.no_input'
      : o.retryOffer === 'safe'
        ? 'card.turn_failed.retry_safe'
        : 'card.turn_failed.retry_caveated';
  elements.push({ tag: 'markdown', content: t(adviceKey, undefined, locale) });

  const actions: any[] = [];
  if (canRetry) {
    actions.push({
      tag: 'button',
      text: {
        tag: 'plain_text',
        // 语义跟着动作走：没跑过 = 重试（重发原话）；跑过一半 = 继续（读现场后
        // 从 checkpoint 接着做）。文案说错会让用户对副作用风险判断错。
        content: t(
          o.retryOffer === 'safe' ? 'card.btn.retry_turn' : 'card.btn.continue_turn',
          undefined,
          locale,
        ),
      },
      // caveated 用 default 而不是 primary：可能重复副作用的操作不该是视觉默认项。
      type: o.retryOffer === 'safe' ? 'primary' : 'default',
      value: {
        action: 'retry_turn',
        turn_id: o.retryTurnId,
        // handler 据此决定提交「原话」还是「续跑指令」。渲染与执行读同一个
        // retryOffer，卡上写的语义就是真正会发生的事。
        mode: o.retryOffer === 'safe' ? 'resend' : 'continue',
        ...actionBase,
      },
    });
  }
  if (o.terminalUrl) {
    actions.push({
      tag: 'button',
      text: { tag: 'plain_text', content: t('card.btn.open_terminal', undefined, locale) },
      type: 'default',
      multi_url: terminalMultiUrl(o.terminalUrl),
    });
  }
  if (actions.length > 0) elements.push({ tag: 'action', actions });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: 'plain_text',
        content: t(titleKey, { cliName: plainTitle(o.cliName) }, locale),
      },
      template: 'red',
    },
    elements,
  });
}

/** 授权处置后的终态卡（无按钮，防重复点击）。 */
function formatGrantExpiry(expiresAt: number, locale?: Locale): string {
  return new Date(expiresAt).toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { hour12: false });
}

/** 被授权目标的 @ 渲染：bot 有名字用纯文本(不 <at> 免唤醒对方)，真人/无名字 bot 用 <at> 点名。 */
type GrantTargetEntry = { openId: string; name?: string; isBot?: boolean };
function renderGrantAtMentions(target: string | string[] | GrantTargetEntry[]): string {
  const entries = (Array.isArray(target) ? target : [target]).map(tt =>
    typeof tt === 'string' ? { openId: tt, name: undefined as string | undefined, isBot: false } : tt);
  return entries.map(e =>
    e.isBot && e.name && e.name.length > 0
      ? e.name
      : `<at id=${e.openId}></at>`,
  ).join(' ');
}

/** 授权处置后的终态卡（无按钮，防重复点击）。授权成功(chat/global)时**就地 patch 原卡**即为
 *  此卡：正文直接 @ 被授权人 + 额度/有效期,一张卡既是结果态又 ping 到 ta,无需再单独发通知卡或
 *  撤回原卡（见申晗 2026-07-31 反馈）。deny 或无 targets 时回落到不带 @ 的简单状态文案。 */
export function buildGrantResultCard(
  kind: 'chat' | 'global' | 'deny',
  locale?: Locale,
  quota?: number,
  expiresAt?: number,
  targets?: string | string[] | GrantTargetEntry[],
): string {
  let content: string;
  const at = targets !== undefined ? renderGrantAtMentions(targets) : '';
  if (kind !== 'deny' && at) {
    // 授权成功且有被授权人：复用 notify 文案（{at} 已获授权，发消息 @ 我即可 + 额度/有效期后缀），
    // 让就地 patch 的原卡直接把授权成功通知 + @ping 合为一张。
    content = t(kind === 'chat' ? 'card.grant.notify_chat' : 'card.grant.notify_global', { at }, locale);
    if (quota !== undefined && quota > 0) content += t('card.grant.notify_quota_suffix', { n: quota }, locale);
    if (expiresAt !== undefined) content += t('card.grant.notify_expiry_suffix', { time: formatGrantExpiry(expiresAt, locale) }, locale);
  } else {
    // deny / 无 targets 回落：简单状态态（无 @）。
    const key = kind === 'chat' ? 'card.grant.result_chat' : kind === 'global' ? 'card.grant.result_global' : 'card.grant.result_deny';
    content = t(key, undefined, locale);
    if (kind !== 'deny') {
      if (expiresAt !== undefined) content += `\n${t('card.grant.result_expiry', { time: formatGrantExpiry(expiresAt, locale) }, locale)}`;
      if (quota !== undefined) content += `\n${t('card.grant.result_quota', { n: quota }, locale)}`;
    }
  }
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default' },
    header: { template: kind === 'deny' ? 'grey' : 'green', title: { tag: 'plain_text', content: t('card.grant.title', undefined, locale) } },
    body: { elements: [{ tag: 'markdown', content }] },
  };
  return JSON.stringify(card);
}

// ─── TUI Prompt cards ───────────────────────────────────────────────────────

/**
 * Build a Feishu interactive card for a TUI prompt (ask-hook / CoCo picker).
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

/** Build a terminal failure state when worker/backend input was not confirmed. */
export function buildTuiPromptFailedCard(message: string, locale?: Locale): string {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: t('card.status.failed', undefined, locale) },
      template: 'red',
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: escapeMd(message) },
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
  /** Snapshot of whether the session's worker is mid-turn at render time.
   *  When the selected entry is running, the picker disables the confirm
   *  button (transferSession would refuse a busy worker anyway). Snapshot,
   *  not live — re-selecting the entry recomputes it. */
  running?: boolean;
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

/** Search aliases appended to a p2p entry's haystack so searching by the
 *  RENDERED location label finds it. A p2p entry's chatLabel carries the raw
 *  DM chatId (an oc_ opaque id — never shown), while the card renders the
 *  localized `card.relay.type_p2p` literal instead; without these aliases,
 *  typing the label the user actually SEES (「单聊」) returned「没有匹配」.
 *  Covers both locales' literals plus common synonyms so the filter stays
 *  locale-agnostic. Keep in sync with the `card.relay.type_p2p` i18n values. */
const RELAY_P2P_SEARCH_ALIASES = '单聊 私聊 p2p dm direct message';

/**
 * Match against title / chatLabel / workingDir / cliId. Case-insensitive
 * substring. Empty / whitespace query matches everything. p2p entries also
 * match their rendered location label via RELAY_P2P_SEARCH_ALIASES.
 */
function relayPickerFilter(entries: RelayPickerEntry[], query: string | undefined): RelayPickerEntry[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const haystack = [e.title, e.chatLabel, e.workingDir, e.cliId, e.chatMode === 'p2p' ? RELAY_P2P_SEARCH_ALIASES : undefined]
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
  invokerOpenId: string,
  locale?: Locale,
  state?: RelayPickerState,
  /** Target routing scope baked into every button value so the confirm /
   *  re-render handlers know whether to land the relayed session as a 话题
   *  (thread, reply_in_thread to `root_id`) or flat chat-scope. Default 'chat'
   *  preserves the legacy普通群-flat behavior. */
  targetScope: 'thread' | 'chat' = 'chat',
  /** Target chat type baked into every button value so relay_confirm can pass
   *  the right chatType to transferSession (a DM target must flip the session
   *  to p2p, or post-relay inbound routing misclassifies it as a group).
   *  Authoritative from the /relay command's session chatType. Default 'group'
   *  covers legacy cards rendered before this field existed. */
  targetChatType: 'group' | 'p2p' = 'group',
  /** When 'private', the card is (or will be) delivered as an ephemeral card
   *  visible only to the invoker — so the session title / source-chat name never
   *  leak to other group members. Baked into every button value as `visibility`
   *  so the re-render handlers (select / page / search) know they must delete +
   *  resend an ephemeral card instead of returning a body for Lark to patch in
   *  place (ephemeral cards can't be PATCH-updated). Default 'public' preserves
   *  the legacy visible-to-all picker. Only ever set 'private' for flat chat-
   *  scope 普通群 targets: ephemeral has no thread anchor, so command-handler
   *  gates it on `targetScope === 'chat'` (thread-scope 话题群/话题 stay public
   *  in-thread — see the gate comment there). p2p never goes ephemeral. */
  visibility: 'private' | 'public' = 'public',
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
  // can reconstruct what the user was looking at. `invoker_open_id` pins the
  // card to the user who originally summoned it — card-handler refuses
  // re-render / confirm clicks from anyone else, so the menu doesn't get
  // silently swapped to a passer-by's session list.
  const stateValue = {
    target_chat_id: targetChatId,
    root_id: targetRootMessageId,
    target_scope: targetScope,
    target_chat_type: targetChatType,
    invoker_open_id: invokerOpenId,
    visibility,
    search: searchQuery,
    page,
    selected: selectedSessionId ?? '',
  };

  // ─── Search box ─────────────────────────────────────────────────────
  // v2 input supports `behaviors` natively — pressing Enter or clicking
  // the built-in submit icon inside the input fires the callback. No
  // separate 搜索 button needed (王皓 reported that button rendered as
  // "..." due to cramped column width; the auto-submit input avoids the
  // problem entirely AND removes the manual click).
  //
  // On submit the callback delivers `action.input_value` (the typed
  // string) and `action.value` (our state object). card-handler reads
  // input_value to update search, resets page to 0 and clears selection.
  elements.push({
    tag: 'input',
    name: RELAY_SEARCH_FIELD,
    placeholder: { tag: 'plain_text', content: t('card.relay.search_placeholder', undefined, locale) },
    default_value: searchQuery,
    width: 'fill',
    behaviors: [
      {
        type: 'callback',
        value: { action: 'relay_search', ...stateValue, selected: '' /* new search → reset selection */ },
      },
    ],
  });

  elements.push({ tag: 'hr' });

  // ─── Empty / no-match notice ────────────────────────────────────────
  if (entries.length === 0) {
    elements.push({ tag: 'markdown', content: t('card.relay.empty', undefined, locale) });
    return JSON.stringify(wrapCard(elements, locale, targetChatType));
  }
  if (filtered.length === 0) {
    elements.push({
      tag: 'markdown',
      content: t('card.relay.empty_filtered', { query: searchQuery }, locale),
    });
    return JSON.stringify(wrapCard(elements, locale, targetChatType));
  }

  // ─── Session cards (current page) ───────────────────────────────────
  const p2pLocationLabel = t('card.relay.type_p2p', undefined, locale);
  const labelType     = t('card.relay.field_type',     undefined, locale);
  const labelLocation = t('card.relay.field_location', undefined, locale);
  const labelTime     = t('card.relay.field_time',     undefined, locale);
  const labelStatus   = t('card.relay.field_status',   undefined, locale);
  const selectedTag   = t('card.relay.selected_tag',   undefined, locale);
  const selectedEntry = selectedSessionId ? filtered.find(e => e.sessionId === selectedSessionId) : undefined;
  const hasValidSelection = !!selectedEntry;
  // Selected session is mid-turn — confirm must be disabled (transferSession
  // would refuse a busy worker; catch it at the button so no M1 is sent).
  const selectionRunning = !!selectedEntry?.running;

  visible.forEach((e) => {
    const isSelected = e.sessionId === selectedSessionId;
    const typeTag = relayPickerTypeTag(e.chatMode, locale);
    const locationLine = e.chatMode === 'p2p' ? p2pLocationLabel : e.chatLabel;
    const titleLine = isSelected
      ? `**✅ ${escapeMd(e.title)}** \`${selectedTag}\``
      : `**${escapeMd(e.title)}**`;
    const statusTag = e.running
      ? t('card.relay.status_running', undefined, locale)
      : t('card.relay.status_idle', undefined, locale);
    const lines: string[] = [
      titleLine,
      `${labelStatus}: ${statusTag}`,
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
  if (hasValidSelection && selectionRunning) {
    // Selected session is mid-turn: render a disabled (grey, non-clickable)
    // button instead of the confirm action. Re-clicking the session entry
    // re-renders and recomputes `running`, so once the turn finishes the
    // user can click it again to get the live confirm button back.
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
              text: { tag: 'plain_text', content: t('card.relay.btn_confirm_running', undefined, locale) },
              type: 'default',
              disabled: true,
            },
          ],
        },
      ],
    });
  } else if (hasValidSelection) {
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
              text: { tag: 'plain_text', content: t(targetChatType === 'p2p' ? 'card.relay.btn_confirm_p2p' : 'card.relay.btn_confirm', undefined, locale) },
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

  return JSON.stringify(wrapCard(elements, locale, targetChatType));
}

function wrapCard(elements: any[], locale?: Locale, targetChatType: 'group' | 'p2p' = 'group'): any {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: {
      title: { tag: 'plain_text', content: t(targetChatType === 'p2p' ? 'card.relay.title_p2p' : 'card.relay.title', undefined, locale) },
      template: 'blue',
    },
    body: { direction: 'vertical', elements },
  };
}

// ─── /adopt picker (V2: search + card list + pagination) ────────────────────
//
// Replaces the two legacy select_static dropdowns. Unifies the two adopt
// sources — live processes (tmux/zellij/herdr) and disk-resumable history —
// into ONE searchable, paginated card list styled like the /relay picker, so
// each entry can surface CLI type / cwd / session id / time / source instead
// of a single cramped dropdown line. Selection + confirm dispatch to the
// right backend based on `kind` (startAdoptSession vs startResumeImportSession).

export type AdoptEntryKind = 'live' | 'resume';

export interface AdoptPickerEntry {
  /** Synthetic selection key, unique & deterministic across both sources.
   *  live  → "live:" + adoptTargetKey / zellij target;  resume → "resume:" + cliSessionId.
   *  Deterministic so a re-render (which re-discovers) reproduces the same key. */
  key: string;
  kind: AdoptEntryKind;
  cliId?: CliId;
  cliDisplayName?: string;
  /** resume: first user prompt; live: project (cwd basename). */
  title: string;
  /** cwd basename, shown compactly. */
  project: string;
  /** Absolute working dir, shown verbatim. */
  cwd: string;
  /** live: probed CLI session id (may be undefined); resume: cliSessionId. */
  sessionId?: string;
  /** live: tmux/zellij/herdr target label. */
  target?: string;
  /** live: startedAt (uptime); resume: lastActivityAt. */
  timeMs?: number;
  /** One-based position among history candidates, for same-screen disambiguation. */
  candidateNumber?: number;
}

/** Deterministic key for a live adoptable session (tmux/herdr/zellij).
 *  Exported so the card-handler's confirm path can match a clicked entry_key
 *  back to a freshly-discovered session without re-deriving the format.
 *
 *  ⚠️ zellij keys are pid-AGNOSTIC on purpose — do NOT add cliPid back.
 *  Confirm re-discovers and matches `adoptLiveKey(fresh) === entryKey`; a
 *  zellij pane's resolved CLI pid legitimately shifts between render and
 *  confirm (wrapper⇄native collapse, re-fork), so baking pid into the key
 *  makes that match spuriously fail → user sees a false "目标已退出". This
 *  is exactly the bug fix 57dcbebbb removed ("点击候选改按 (session,paneId)
 *  匹配"): (zellijSession, zellijPaneId) already uniquely identifies the pane.
 *  tmux/herdr keep adoptTargetKey (tmux includes pid, herdr does not) — tmux's
 *  confirm fast-path parses the trailing pid, and that path is unchanged. */
export function adoptLiveKey(s: AdoptableSession | ZellijAdoptableSession): string {
  if ('zellijPaneId' in s) return `live:zellij:${s.zellijSession}/${s.zellijPaneId}`;
  return `live:${adoptTargetKey(s)}`;
}

/** Fold both adopt sources into one uniform entry list. Live entries come
 *  first (they're the "act now" targets), resume entries after. Order is
 *  stable so pagination is deterministic across re-renders.
 *
 *  `resumeCliId` labels the resume (history) entries with the bot's own CLI —
 *  ResumableSession carries no cliId (resume only ever offers the bot's own
 *  CLI, so the caller knows it), and the user wants to see "Codex" on each
 *  history row rather than a blank. */
export function buildAdoptEntries(
  sessions: Array<AdoptableSession | ZellijAdoptableSession>,
  resumable: ResumableSession[],
  resumeCliId?: CliId,
  runtimeDisplayName?: string,
): AdoptPickerEntry[] {
  const customName = runtimeDisplayName?.trim();
  const live: AdoptPickerEntry[] = sessions.map((s) => {
    const zellij = 'zellijPaneId' in s;
    const project = s.cwd.split('/').pop() || s.cwd;
    const target = zellij ? `${s.zellijSession}/${s.zellijPaneId}` : adoptTargetLabel(s);
    return {
      key: adoptLiveKey(s),
      kind: 'live' as const,
      cliId: s.cliId,
      ...(customName && s.cliId === resumeCliId ? { cliDisplayName: customName } : {}),
      title: project,
      project,
      cwd: s.cwd,
      sessionId: s.sessionId,
      target,
      timeMs: s.startedAt,
    };
  });
  const resume: AdoptPickerEntry[] = resumable.map((r, index) => {
    const project = r.cwd.split('/').pop() || r.cwd;
    return {
      key: `resume:${r.cliSessionId}`,
      kind: 'resume' as const,
      cliId: resumeCliId,
      ...(customName ? { cliDisplayName: customName } : {}),
      title: r.title || project,
      project,
      cwd: r.cwd,
      sessionId: r.cliSessionId,
      timeMs: r.lastActivityAt || undefined,
      candidateNumber: index + 1,
    };
  });
  return [...live, ...resume];
}

export interface AdoptPickerState {
  selectedKey?: string;
  searchQuery?: string;
  page?: number;
}

const ADOPT_PICKER_PAGE_SIZE = 5;
const ADOPT_SEARCH_FIELD = 'adopt_search_q';

/** Case-insensitive substring over title / project / cwd / cliId / sessionId.
 *  Empty query matches everything. Includes sessionId so a user who knows the
 *  id can type it and jump straight to the entry. */
function adoptPickerFilter(entries: AdoptPickerEntry[], query: string | undefined): AdoptPickerEntry[] {
  const q = (query ?? '').trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => {
    const haystack = [e.title, e.project, e.cwd, e.cliId, e.cliDisplayName, e.sessionId, e.target]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * V2 adopt picker card. Layout mirrors buildRelayPickerCard: search box →
 * ≤5 session cards (clickable, highlight on select) → paginator → confirm.
 * All state (search / page / selected / root_id / invoker) rides on the
 * value objects since Lark cards are stateless server-side.
 *
 * `truncated` renders a hint when the resume list was capped, so the user
 * knows to narrow via search instead of assuming they saw everything.
 */
export function buildAdoptSelectCard(
  sessions: Array<AdoptableSession | ZellijAdoptableSession>,
  rootMessageId?: string,
  locale?: Locale,
  resumable?: ResumableSession[],
  state?: AdoptPickerState,
  invokerOpenId?: string,
  resumeLimit?: number,
  resumeCliId?: CliId,
  runtimeDisplayName?: string,
): string {
  const entries = buildAdoptEntries(sessions, resumable ?? [], resumeCliId, runtimeDisplayName);
  const searchQuery = state?.searchQuery ?? '';
  const requestedPage = state?.page ?? 0;
  const selectedKey = state?.selectedKey;
  const elements: any[] = [];

  const unknownUptime = t('card.adopt.uptime_unknown', undefined, locale);
  const sessionUnknown = t('card.adopt.session_unknown', undefined, locale);

  // Truncation hint: resume discovery caps at resumeLimit; if it came back
  // full, the user is probably not seeing everything → tell them to search.
  const resumeCount = (resumable ?? []).length;
  const truncated = !!resumeLimit && resumeCount >= resumeLimit;

  // ─── Filter & paginate ───────────────────────────────────────────────
  const filtered = adoptPickerFilter(entries, searchQuery);
  const totalPages = Math.max(1, Math.ceil(filtered.length / ADOPT_PICKER_PAGE_SIZE));
  const page = Math.min(Math.max(0, requestedPage), totalPages - 1);
  const start = page * ADOPT_PICKER_PAGE_SIZE;
  const visible = filtered.slice(start, start + ADOPT_PICKER_PAGE_SIZE);

  // Common state carried by every interactive value so re-renders can
  // reconstruct the view. invoker_open_id pins the card to its summoner.
  const stateValue: Record<string, unknown> = {
    root_id: rootMessageId ?? '',
    invoker_open_id: invokerOpenId ?? '',
    search: searchQuery,
    page,
    selected: selectedKey ?? '',
  };

  // ─── Search box (auto-submit input, same as relay) ──────────────────
  elements.push({
    tag: 'input',
    name: ADOPT_SEARCH_FIELD,
    placeholder: { tag: 'plain_text', content: t('card.adopt.search_placeholder', undefined, locale) },
    default_value: searchQuery,
    width: 'fill',
    behaviors: [
      {
        type: 'callback',
        value: { action: 'adopt_search', ...stateValue, selected: '' /* new search → reset selection */ },
      },
    ],
  });
  if (truncated) {
    elements.push({
      tag: 'markdown',
      content: `<font color='orange'>${t('card.adopt.truncated', { limit: resumeLimit }, locale)}</font>`,
    });
  }
  elements.push({ tag: 'hr' });

  // ─── Empty / no-match ───────────────────────────────────────────────
  if (entries.length === 0) {
    elements.push({ tag: 'markdown', content: t('card.adopt.empty', undefined, locale) });
    return JSON.stringify(wrapAdoptCard(elements, locale));
  }
  if (filtered.length === 0) {
    // escapeMd the echoed query: it's raw operator input rendered into a
    // markdown element, so an unescaped `![](http://x)` would render as an
    // image (external fetch = tracking beacon / SSRF surface). Neutralising
    // [ ] ` etc. defuses that. (buildRelayPickerCard echoes its query the
    // same way and shares the same latent risk — tracked separately.)
    elements.push({ tag: 'markdown', content: t('card.adopt.empty_filtered', { query: escapeMd(searchQuery) }, locale) });
    return JSON.stringify(wrapAdoptCard(elements, locale));
  }

  const labelKind    = t('card.adopt.field_kind',    undefined, locale);
  const labelCli     = t('card.adopt.field_cli',     undefined, locale);
  const labelDir     = t('card.adopt.field_dir',     undefined, locale);
  const labelCandidate = t('card.adopt.field_candidate', undefined, locale);
  const labelTarget  = t('card.adopt.field_target',  undefined, locale);
  const selectedTag  = t('card.adopt.selected_tag',  undefined, locale);
  const selectedEntry = selectedKey ? filtered.find(e => e.key === selectedKey) : undefined;
  const hasValidSelection = !!selectedEntry;

  // ─── Session cards (current page) ───────────────────────────────────
  visible.forEach((e) => {
    const isSelected = e.key === selectedKey;
    const kindTag = e.kind === 'live'
      ? t('card.adopt.kind_live', undefined, locale)
      : t('card.adopt.kind_resume', undefined, locale);
    const cliName = e.cliDisplayName ?? (e.cliId ? getCliDisplayName(e.cliId) : '—');
    const timeLabel = e.kind === 'live'
      ? t('card.adopt.field_time_live', undefined, locale)
      : t('card.adopt.field_time_resume', undefined, locale);
    const timeVal = e.timeMs
      ? (e.kind === 'live' ? formatDuration(Date.now() - e.timeMs) : formatThreadUpdatedAt(e.timeMs, locale))
      : unknownUptime;
    const titleLine = isSelected
      ? `**✅ ${escapeMd(e.title)}** \`${selectedTag}\``
      : `**${escapeMd(e.title)}**`;
    const lines: string[] = [
      titleLine,
      `${labelKind}: ${kindTag}`,
      `${labelCli}: ${escapeMd(cliName)}`,
      `${labelDir}: \`${escapeMd(e.cwd)}\``,
    ];
    if (e.kind === 'resume' && e.candidateNumber) lines.push(`${labelCandidate}: #${e.candidateNumber}`);
    if (e.kind === 'live' && e.target) lines.push(`${labelTarget}: \`${escapeMd(e.target)}\``);
    lines.push(`${timeLabel}: ${timeVal}`);
    elements.push({
      tag: 'interactive_container',
      width: 'fill',
      padding: '8px 12px',
      background_style: isSelected ? 'laser' : 'default',
      has_border: true,
      border_color: isSelected ? 'blue-500' : 'grey-200',
      corner_radius: '8px',
      behaviors: [
        { type: 'callback', value: { action: 'adopt_pick', entry_key: e.key, ...stateValue } },
      ],
      elements: [{ tag: 'markdown', content: lines.join('\n') }],
    });
  });

  // ─── Paginator ──────────────────────────────────────────────────────
  if (totalPages > 1) {
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'default',
      columns: [
        {
          tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.relay.btn_prev_page', undefined, locale) },
            type: 'default',
            disabled: page === 0,
            behaviors: [{ type: 'callback', value: { action: 'adopt_page', ...stateValue, page: Math.max(0, page - 1) } }],
          }],
        },
        {
          tag: 'column', width: 'weighted', weight: 2, vertical_align: 'center',
          elements: [{
            tag: 'markdown', text_align: 'center',
            content: t('card.relay.page_indicator', { current: page + 1, total: totalPages }, locale),
          }],
        },
        {
          tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: t('card.relay.btn_next_page', undefined, locale) },
            type: 'default',
            disabled: page >= totalPages - 1,
            behaviors: [{ type: 'callback', value: { action: 'adopt_page', ...stateValue, page: Math.min(totalPages - 1, page + 1) } }],
          }],
        },
      ],
    });
  }

  // ─── Confirm button or hint ─────────────────────────────────────────
  elements.push({ tag: 'hr' });
  if (hasValidSelection) {
    const btnKey = selectedEntry!.kind === 'live' ? 'card.adopt.btn_confirm_live' : 'card.adopt.btn_confirm_resume';
    elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: [{
        tag: 'column', width: 'weighted', weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: t(btnKey, undefined, locale) },
          type: 'primary',
          behaviors: [{ type: 'callback', value: { action: 'adopt_confirm', entry_key: selectedEntry!.key, ...stateValue } }],
        }],
      }],
    });
  } else {
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>${t('card.adopt.hint_pick_first', undefined, locale)}</font>`,
    });
  }

  return JSON.stringify(wrapAdoptCard(elements, locale));
}

function wrapAdoptCard(elements: any[], locale?: Locale): any {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('card.adopt.title', undefined, locale) },
    },
    body: { direction: 'vertical', elements },
  };
}


function compactPlainText(s: string, max = 72): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function formatThreadUpdatedAt(ms: number | undefined, locale?: Locale): string {
  if (!ms) return t('card.codex_app_thread.updated_unknown', undefined, locale);
  const loc = locale === 'en' ? 'en-US' : 'zh-CN';
  return new Date(ms).toLocaleString(loc, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function buildCodexAppThreadSelectCard(threads: CodexAppThreadSummary[], rootMessageId?: string, locale?: Locale): string {
  const options = threads.map((thread) => {
    const title = compactPlainText(thread.name || thread.preview || thread.threadId, 44);
    const project = compactPlainText(thread.cwd.split('/').pop() || thread.cwd, 18);
    const updated = formatThreadUpdatedAt(thread.updatedAtMs, locale);
    return {
      text: { tag: 'plain_text' as const, content: `${title} · ${project} · ${updated}` },
      value: JSON.stringify({ threadId: thread.threadId }),
    };
  });

  const card = {
    config: { wide_screen_mode: true },
    header: {
      template: 'blue',
      title: { tag: 'plain_text', content: t('card.codex_app_thread.title', undefined, locale) },
    },
    elements: [
      {
        tag: 'div',
        text: { tag: 'lark_md', content: t('card.codex_app_thread.subtitle', undefined, locale) },
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'select_static',
            placeholder: { tag: 'plain_text', content: t('card.codex_app_thread.placeholder_select', undefined, locale) },
            options,
            value: { key: 'codex_app_thread_select', root_id: rootMessageId ?? '' },
          },
        ],
      },
    ],
  };
  return JSON.stringify(card);
}

// ── Sandbox landing card (owner reviews the sandbox clone's diff, then applies
//    it back to the real repo). Owner-gated apply; the agent never sees this. ──
export interface LandCardOpts {
  sessionId: string;
  workingDir: string;
  statText: string;
  files: number;
  insertions: number;
  deletions: number;
  preview: string;        // patch text for the in-card preview (already truncated)
  truncated?: boolean;    // preview was cut → full diff is in the attached .patch
  patchAttached?: boolean; // a .patch file message accompanies this card
}

export function buildLandCard(o: LandCardOpts, locale?: Locale): string {
  const v = { sessionId: o.sessionId, workingDir: o.workingDir };
  const body = t('card.land.body', { files: o.files, ins: o.insertions, del: o.deletions, dir: escapeMd(o.workingDir) }, locale);
  const elements: any[] = [{ tag: 'div', text: { tag: 'lark_md', content: body } }];
  // Use the card v2 `markdown` element (NOT a lark_md div) for the stat + diff —
  // it renders ``` fenced code blocks as real monospace blocks, which lark_md
  // divs do not. Paths are already project-relative (computeSandboxDiff).
  if (o.statText) elements.push({ tag: 'markdown', content: `**${t('card.land.files_header', undefined, locale)}**\n` + '```text\n' + o.statText.slice(0, 2000) + '\n```' });
  if (o.preview) {
    const note = o.truncated ? `\n\n_${t('card.land.truncated', undefined, locale)}_` : '';
    elements.push({ tag: 'markdown', content: `**${t('card.land.preview_header', undefined, locale)}**\n` + '```diff\n' + o.preview + '\n```' + note });
  }
  if (o.patchAttached) elements.push({ tag: 'note', elements: [{ tag: 'lark_md', content: t('card.land.patch_note', undefined, locale) }] });
  elements.push(
    { tag: 'hr' },
    { tag: 'action', actions: [
      { tag: 'button', type: 'primary', text: { tag: 'plain_text', content: t('card.land.btn_apply', undefined, locale) }, value: { action: 'land_apply', ...v } },
      { tag: 'button', type: 'danger', text: { tag: 'plain_text', content: t('card.land.btn_discard', undefined, locale) }, value: { action: 'land_discard', ...v } },
    ] },
    { tag: 'note', elements: [{ tag: 'lark_md', content: t('card.land.note', undefined, locale) }] },
  );
  return JSON.stringify({ config: { wide_screen_mode: true }, header: { template: 'turquoise', title: { tag: 'plain_text', content: t('card.land.title', undefined, locale) } }, elements });
}

export function buildLandResultCard(kind: 'applied' | 'discarded' | 'failed', detail: string, locale?: Locale): string {
  const meta = {
    applied: { template: 'green', titleKey: 'card.land.applied_title' },
    discarded: { template: 'grey', titleKey: 'card.land.discarded_title' },
    failed: { template: 'red', titleKey: 'card.land.failed_title' },
  }[kind];
  const body = detail || (kind === 'discarded' ? t('card.land.discarded_body', undefined, locale) : '');
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: meta.template, title: { tag: 'plain_text', content: t(meta.titleKey, undefined, locale) } },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: body } }],
  });
}

export interface GoalHumanAttentionCardInput {
  ownerOpenId?: string;
  goalTitle?: string;
  goalChatId: string;
  goalLink?: string;
  taskId?: string;
  taskTitle?: string;
  attentionKind?: string;
  attentionReason?: string;
  decisionOptions?: GoalDecisionOption[];
  summary: string;
  notificationMessageId?: string;
  notificationLarkAppId?: string;
  parentChatId: string;
  parentRoot?: string;
  parentSessionId?: string;
  supervisorSessionId?: string;
}

function goalDisplayTitle(input: { goalTitle?: string; goalChatId?: string }): string {
  return input.goalTitle?.trim() || '当前目标';
}

function taskDisplayTitle(input: { taskTitle?: string; taskId?: string }): string | undefined {
  const title = input.taskTitle?.trim();
  if (title) return title;
  if (!input.taskId?.trim()) return undefined;
  return `任务号 ${input.taskId.trim()}`;
}

export function buildGoalHumanAttentionCard(input: GoalHumanAttentionCardInput): string {
  const kind = input.attentionKind ?? 'blocked';
  const isHelp = kind === 'help';
  const header = isHelp
    ? { template: 'blue', title: '🆘 执行者求助，需要支援' }
    : { template: kind === 'blocked' ? 'orange' : 'red', title: '⚠️ 任务需要你拍板' };
  const mention = input.ownerOpenId ? `<at id=${input.ownerOpenId}></at> ` : '';
  const title = goalDisplayTitle(input);
  const taskTitle = taskDisplayTitle(input);
  const actionValue: Record<string, string> = {
    action: 'goal_parent_decision',
    goal_chat_id: input.goalChatId,
    parent_chat_id: input.parentChatId,
    parent_message_id: input.notificationMessageId ?? '',
    notification_lark_app_id: input.notificationLarkAppId ?? '',
    summary: truncateCardText(input.summary, 1000),
  };
  if (input.taskId) actionValue.task_id = input.taskId;
  if (input.taskTitle) actionValue.task_title = input.taskTitle;
  if (input.goalTitle) actionValue.goal_title = input.goalTitle;
  if (input.attentionKind) actionValue.attention_kind = input.attentionKind;
  if (input.attentionReason) actionValue.attention_reason = input.attentionReason;
  if (input.parentRoot) actionValue.parent_root = input.parentRoot;
  if (input.parentSessionId) actionValue.parent_session_id = input.parentSessionId;
  if (input.supervisorSessionId) actionValue.supervisor_session_id = input.supervisorSessionId;

  const fields = [
    { is_short: true, text: { tag: 'lark_md', content: `**目标**\n${escapeMd(title)}` } },
    { is_short: true, text: { tag: 'lark_md', content: `**类型**\n${escapeMd(isHelp ? '求助' : '需拍板')}` } },
    taskTitle ? { is_short: true, text: { tag: 'lark_md', content: `**任务**\n${escapeMd(taskTitle)}` } } : undefined,
  ].filter(Boolean);

  const elements: any[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: [
          `${mention}${isHelp ? '执行者正在求助，需要你提供支援或决策。' : '监管者遇到需要你拍板的事项。'}`,
          input.goalLink ? `[打开目标群](${input.goalLink})` : undefined,
        ].filter(Boolean).join('\n'),
      },
    },
    { tag: 'div', fields },
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**原因**\n${escapeMd(truncateCardText(input.attentionReason ?? input.summary, 1000))}` },
    },
  ];
  if (input.summary && input.summary !== input.attentionReason) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**摘要**\n${escapeMd(truncateCardText(input.summary, 1200))}` },
    });
  }
  const optionActions = (input.decisionOptions ?? []).map((opt) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${opt.recommended ? '⭐ ' : ''}${opt.label}` },
    type: opt.recommended ? 'primary' : 'default',
    value: {
      ...actionValue,
      action: 'goal_parent_decision_option',
      decision_key: opt.key,
      decision_text: opt.label,
    },
  }));
  if (optionActions.length) {
    elements.push(
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: '**推荐选项**\n点一个选项会直接下发给监管者；复杂情况仍可用下方自由输入。' } },
      { tag: 'action', actions: optionActions },
    );
  }
  elements.push(
    { tag: 'hr' },
    {
      tag: 'action',
      actions: [
        input.goalLink ? {
          tag: 'button',
          text: { tag: 'plain_text', content: '打开目标群' },
          type: 'default',
          multi_url: {
            url: input.goalLink,
            pc_url: input.goalLink,
            android_url: input.goalLink,
            ios_url: input.goalLink,
          },
        } : undefined,
      ].filter(Boolean),
    },
    {
      tag: 'form',
      name: 'goal_parent_decision_form',
      elements: [
        {
          tag: 'input',
          name: 'goal_parent_decision_text',
          placeholder: { tag: 'plain_text', content: '输入要下发给监管者的决策 / 补充信息' },
        },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '下发决策' },
          type: 'primary',
          name: 'goal_parent_decision_submit',
          action_type: 'form_submit',
          value: actionValue,
        },
      ],
    },
    { tag: 'note', elements: [{ tag: 'lark_md', content: '也可以直接引用回复这张卡片；两种方式都会转给监管者。' }] },
  );

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements,
  });
}

export function buildGoalHumanAttentionResolvedCard(input: GoalHumanAttentionCardInput & { decisionText: string; decisionMode?: 'option' | 'free-text' }): string {
  const title = goalDisplayTitle(input);
  const taskTitle = taskDisplayTitle(input);
  const fields = [
    { is_short: true, text: { tag: 'lark_md', content: `**目标**\n${escapeMd(title)}` } },
    taskTitle ? { is_short: true, text: { tag: 'lark_md', content: `**任务**\n${escapeMd(taskTitle)}` } } : undefined,
    { is_short: true, text: { tag: 'lark_md', content: `**状态**\n监管者处理中` } },
  ].filter(Boolean);
  const elements: any[] = [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: [
          '✅ 人类决策已下发给监管者。',
          input.goalLink ? `[打开目标群](${input.goalLink})` : undefined,
        ].filter(Boolean).join('\n'),
      },
    },
    { tag: 'div', fields },
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: `**${input.decisionMode === 'option' ? '已选' : '已下发决策'}**\n${escapeMd(truncateCardText(input.decisionText, 1200))}`,
      },
    },
    { tag: 'note', elements: [{ tag: 'lark_md', content: '如需补充，请引用回复这张卡片；卡片内表单已关闭，避免重复下发。' }] },
  ];
  if (input.goalLink) {
    elements.splice(3, 0, {
      tag: 'action',
      actions: [{
        tag: 'button',
        text: { tag: 'plain_text', content: '打开目标群' },
        type: 'default',
        multi_url: {
          url: input.goalLink,
          pc_url: input.goalLink,
          android_url: input.goalLink,
          ios_url: input.goalLink,
        },
      }],
    });
  }

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { template: 'green', title: { tag: 'plain_text', content: '✅ 决策已下发' } },
    elements,
  });
}
