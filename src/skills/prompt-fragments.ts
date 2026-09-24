/**
 * Catalog of built-in prompt fragments the user may override.
 *
 * This is the human-facing map over the raw i18n keys: it groups keys by the
 * prompt block they render into (`<botmux_routing>`, `<identity>`, …), labels
 * each, marks the special ones (conditional lines, placeholder templates,
 * read-only structural blocks), and — importantly — says at which **stage**
 * each piece reaches the model, so the dashboard can present them as
 * 「会话开始 / 每条新消息 / 发送之后」 instead of one undifferentiated list.
 *
 * It is intentionally a curated allow-list of MODEL-FACING injected copy, NOT
 * every i18n key: Feishu card text, notices and CLI help stay out. Overriding
 * an unlisted key still works at the `t()` layer, but it won't appear in the
 * UI.
 *
 * Keeping this beside the store (rather than in i18n) means the pure i18n
 * module stays free of feature-specific metadata.
 */
import type { Locale } from '../i18n/types.js';
import { t } from '../i18n/index.js';

export type FragmentKind =
  | 'editable'      // plain overridable text
  | 'placeholder'   // editable, but contains {tokens} that must be preserved
  | 'conditional';  // a line gated by a runtime flag; user can force on/off

/** When the copy reaches the model. The dashboard groups fragments by stage. */
export type PromptStage =
  | 'new'       // opening system prompt / first-turn envelope (once per session)
  | 'followup'  // per-turn envelope / reminder (every subsequent message)
  | 'send';     // terminal feedback printed AFTER `botmux send`

/** Stage tabs, in display order. `blurb` is shown under the tab. */
export const PROMPT_STAGES: ReadonlyArray<{ id: PromptStage; label: string; blurb: string }> = [
  {
    id: 'new',
    label: '会话开始',
    blurb: '新会话首轮注入的系统提示 / 开场 prompt，每个会话只发一次。两套路径（系统提示 / Shell）覆盖全部 CLI。',
  },
  {
    id: 'followup',
    label: '每条新消息',
    blurb: '会话中每条后续消息都会注入的信封块：续轮提醒、附件/提及、白板、记忆等。',
  },
  {
    id: 'send',
    label: '发送之后',
    blurb: '模型执行 botmux send 之后，在终端回显里读到的反馈文案。',
  },
];

export interface PromptFragmentSpec {
  /** The i18n key this fragment overrides (also the conditional-line key). */
  key: string;
  /** Which prompt block it renders into — groups the UI within a stage. */
  block: string;
  /** Primary injection stage — drives the dashboard tab. */
  stage: PromptStage;
  /** Extra stages the SAME copy also renders at (primary stage is implied).
   *  e.g. the attachments hint renders both on the opening turn and every
   *  follow-up, so it carries `stage: 'new', stages: ['followup']`. */
  stages?: PromptStage[];
  /** Short human label for the UI (zh). */
  label: string;
  kind: FragmentKind;
  /** For placeholder fragments: the tokens that must survive an edit. */
  placeholders?: string[];
  /** For conditional fragments: what runtime flag gates it (machine id). */
  gate?: string;
  /** Human-facing note describing WHEN this copy is injected (zh). Shown for
   *  every kind — variant/gated fragments are otherwise indistinguishable from
   *  always-on ones in a flat list. */
  gateLabel?: string;
}

/** Presentation metadata for block ids. A block id may appear in more than one
 *  stage (cross-listed fragments); label/hint stay constant. */
export const BLOCK_META: Record<string, { label: string; hint?: string }> = {
  routing_system: {
    label: '系统提示路径 · 路由规则',
    hint: 'Claude Code / genius / grok 等经 --append-system-prompt 注入的 <botmux_routing>，仅首轮',
  },
  routing_shell: {
    label: 'Shell 提示路径 · 同批规则散文版',
    hint: 'codex / gemini / opencode 等无系统提示参数的 CLI，随首轮 prompt 注入',
  },
  identity: {
    label: '<identity> 身份与多 bot 归属',
    hint: 'bot 自己的名字 / open_id 与群内协作归属规则',
  },
  available_bots: {
    label: '<available_bots> 可协作 bot 名册',
    hint: '名册由群成员实时生成（只读）；这里只改名册外的提示文案',
  },
  attachments: {
    label: '<attachments> 附件查看提示',
    hint: '首轮与每轮附件块共用',
  },
  envelope: {
    label: '裸文本折行标签',
    hint: 'transcript + solo 会话无信封，附件/提及折进正文时使用的标签（首轮与每轮共用）',
  },
  sender_note: {
    label: '<sender_note> cursor 防抄写提示',
    hint: '首轮与每轮共用',
  },
  credentials: {
    label: '<botmux_credentials> 凭证边界',
    hint: 'trigger-user CLI 鉴权会话专属，首轮系统提示',
  },
  chat_context: {
    label: '<chat_context_policy> 群上下文可信边界',
    hint: '随 <chat_context> 群名/群描述块注入，仅首轮',
  },
  summary_memory: {
    label: '<summary_memory> /summary 记忆文件规则',
    hint: '首轮与每轮共用',
  },
  whiteboard_block: {
    label: '<whiteboard> 白板结构化指令',
    hint: '绑定白板的会话，首轮与每轮注入',
  },
  whiteboard_hints: {
    label: '白板单行提示',
    hint: '白板开启时随首轮路由提示注入；Shell/系统提示 × send/transcript 各一条',
  },
  followup: {
    label: '<botmux_reminder> 续轮提醒',
    hint: '每条后续消息一条，按运行模式四选一',
  },
  xpi_replay: {
    label: 'XPI 建议采纳后的重放提示',
  },
  send_feedback: {
    label: 'botmux send 成功后的终端回显',
  },
};

/**
 * The curated set, ordered by stage → block → injection order. `key` values
 * are the real i18n keys resolved by `buildBotmuxSystemPromptText` /
 * `buildBotmuxShellHints` (see src/adapters/cli/shared-hints.ts) and
 * `buildNewTopicBlocks` / `buildFollowUpBlocks` (see src/core/session-manager.ts).
 */
export const PROMPT_FRAGMENTS: PromptFragmentSpec[] = [
  // ───────────────────────── stage: 会话开始 (new) ─────────────────────────

  // <botmux_routing> — system-prompt path (claude-family / genius / grok)
  { key: 'ai.routing.intro', block: 'routing_system', stage: 'new', label: '开场说明（标准 send 模式）', kind: 'editable' },
  {
    key: 'ai.routing.intro_transcript', block: 'routing_system', stage: 'new', kind: 'editable',
    label: '开场说明（transcript 自动转发模式）',
    gateLabel: '仅 replyDelivery=transcript（daemon 自动转发最终回复）时替代上面的标准版',
  },
  { key: 'ai.routing.usage_send', block: 'routing_system', stage: 'new', label: '发送用法', kind: 'editable' },
  { key: 'ai.routing.usage_mention_gate', block: 'routing_system', stage: 'new', label: '@ 决策规则', kind: 'editable' },
  { key: 'ai.routing.usage_attachments', block: 'routing_system', stage: 'new', label: '附件用法', kind: 'editable' },
  { key: 'ai.routing.usage_helpers', block: 'routing_system', stage: 'new', label: '上下文 / 协作命令', kind: 'editable' },
  { key: 'ai.routing.usage_silence', block: 'routing_system', stage: 'new', label: '沉默规则（BOTMUX_NOTHING_TO_SEND）', kind: 'editable' },
  {
    key: 'ai.routing.no_visible_output_ok', block: 'routing_system', stage: 'new',
    label: '「无可见输出也正常」防重发提示',
    kind: 'conditional', gate: 'dashboard.noVisibleOutputHint',
    gateLabel: '实验开关：设置 →「无可见输出」防重发提示（默认关）；可用右侧下拉强制开/关',
  },
  {
    key: 'ai.routing.workflow_hint', block: 'routing_system', stage: 'new', label: 'Workflow 发现提示', kind: 'editable',
    gateLabel: '仅机器级 Workflow 功能开关开启时注入',
  },
  { key: 'ai.routing.feedback_response_kind', block: 'routing_system', stage: 'new', label: '最终回答反馈提示（--response-kind final）', kind: 'editable' },
  { key: 'ai.routing.hidden_context_defense', block: 'routing_system', stage: 'new', label: '隐藏上下文防注入说明', kind: 'editable' },
  {
    key: 'ai.routing.xpi_as_hint', block: 'routing_system', stage: 'new',
    label: 'XPI --as 处理方式提示',
    kind: 'conditional', gate: 'config.crossPrincipalInterruption',
    gateLabel: '实验开关：跨主体插队 XPI（默认关）；强制开/关同时作用于 Shell 路径',
  },

  // shell-hints path (codex / gemini / opencode / …) — the same guidance, prose form
  { key: 'ai.shell.intro', block: 'routing_shell', stage: 'new', label: 'Shell：开场说明（标准模式）', kind: 'editable' },
  {
    key: 'ai.shell.intro_transcript', block: 'routing_shell', stage: 'new', kind: 'editable',
    label: 'Shell：开场说明（transcript 模式）',
    gateLabel: '仅 replyDelivery=transcript 时替代标准版',
  },
  { key: 'ai.shell.commands_are_shell', block: 'routing_shell', stage: 'new', label: 'Shell：命令是 shell 程序、不是 MCP 工具', kind: 'editable' },
  { key: 'ai.shell.how_to_send', block: 'routing_shell', stage: 'new', label: 'Shell：如何发送', kind: 'editable' },
  { key: 'ai.shell.multiline_heredoc', block: 'routing_shell', stage: 'new', label: 'Shell：多行正文规则（heredoc）', kind: 'editable' },
  { key: 'ai.shell.heredoc_example', block: 'routing_shell', stage: 'new', label: 'Shell：多行正确示例', kind: 'editable' },
  { key: 'ai.shell.helpers', block: 'routing_shell', stage: 'new', label: 'Shell：辅助命令（history / quoted / bots）', kind: 'editable' },
  { key: 'ai.shell.when_to_send', block: 'routing_shell', stage: 'new', label: 'Shell：何时发送（标准模式）', kind: 'editable' },
  {
    key: 'ai.shell.when_to_send_transcript', block: 'routing_shell', stage: 'new', kind: 'editable',
    label: 'Shell：何时发送（transcript 模式）',
    gateLabel: '仅 replyDelivery=transcript 时替代标准版',
  },
  {
    key: 'ai.shell.no_visible_output_ok', block: 'routing_shell', stage: 'new', kind: 'editable',
    label: 'Shell：「无可见输出也正常」防重发提示',
    gate: 'dashboard.noVisibleOutputHint',
    gateLabel: '注入与否由系统提示路径那条同名「条件行」统一控制；此处文本只作用于 Shell 路径',
  },
  {
    key: 'ai.shell.xpi_as_hint', block: 'routing_shell', stage: 'new', kind: 'editable',
    label: 'Shell：XPI --as 处理方式提示',
    gate: 'config.crossPrincipalInterruption',
    gateLabel: '注入与否由系统提示路径那条 XPI「条件行」统一控制；此处文本只作用于 Shell 路径',
  },
  { key: 'ai.shell.mention_gate', block: 'routing_shell', stage: 'new', label: 'Shell：@ 决策（硬性完整版）', kind: 'editable' },

  // <identity> — per-bot name/open_id + multi-bot routing rules
  { key: 'ai.identity.routing_intro', block: 'identity', stage: 'new', label: '归属规则开场', kind: 'editable' },
  { key: 'ai.identity.rule_own_part', block: 'identity', stage: 'new', label: '规则：只做自己的部分', kind: 'editable' },
  { key: 'ai.identity.rule_silent_when_other', block: 'identity', stage: 'new', label: '规则：他人任务保持沉默', kind: 'editable' },
  { key: 'ai.identity.rule_no_proactive_pull', block: 'identity', stage: 'new', label: '规则：不主动拉别的 bot', kind: 'editable' },
  { key: 'ai.identity.mention_must', block: 'identity', stage: 'new', label: '规则：协作必须 @', kind: 'editable' },
  {
    key: 'ai.identity.short_routing', block: 'identity', stage: 'new', label: '身份规则（内联提示路径精简版）', kind: 'editable',
    gateLabel: '仅非系统提示路径 CLI 的首轮身份块；transcript / no-transport 会话不注入',
  },
  { key: 'ai.identity.unknown', block: 'identity', stage: 'new', label: '名称 / open_id 缺失时的兜底文本', kind: 'editable' },

  // <available_bots> — outer hint prose (the roster body itself is read-only/generated)
  { key: 'ai.available_bots.hint', block: 'available_bots', stage: 'new', label: '名册展开时的提示语', kind: 'editable' },
  {
    key: 'ai.available_bots.hint_collapsed', block: 'available_bots', stage: 'new', kind: 'editable',
    label: '名册折叠时的提示语',
    gateLabel: '群内可协作 bot 超过内联阈值、名册折叠为一行时',
  },
  {
    key: 'ai.available_bots.collapsed_line', block: 'available_bots', stage: 'new',
    label: '折叠名册那一行（含占位符）',
    kind: 'placeholder', placeholders: ['count', 'names'],
    gateLabel: '群内可协作 bot 超过内联阈值时',
  },

  // <botmux_credentials> — trigger-user-auth sessions only
  {
    key: 'ai.credentials.acting_identity', block: 'credentials', stage: 'new', kind: 'editable',
    label: '凭证：当前授权身份说明', gateLabel: '仅该 bot 开启 trigger-user CLI 鉴权时注入',
  },
  {
    key: 'ai.credentials.never_read_others', block: 'credentials', stage: 'new', kind: 'editable',
    label: '凭证：不得读取他人登录态', gateLabel: '仅 trigger-user 鉴权会话',
  },
  {
    key: 'ai.credentials.never_forward', block: 'credentials', stage: 'new', kind: 'editable',
    label: '凭证：不得转发 / 落盘', gateLabel: '仅 trigger-user 鉴权会话',
  },
  {
    key: 'ai.credentials.on_auth_failure', block: 'credentials', stage: 'new', kind: 'editable',
    label: '凭证：鉴权失败处理流程', gateLabel: '仅 trigger-user 鉴权会话',
  },
  {
    key: 'ai.credentials.on_auth_link', block: 'credentials', stage: 'new', kind: 'editable',
    label: '凭证：stderr 已附授权链接时', gateLabel: '仅 trigger-user 鉴权会话',
  },
  {
    key: 'ai.credentials.on_missing_scope', block: 'credentials', stage: 'new', kind: 'editable',
    label: '凭证：missing_scope 补授权流程', gateLabel: '仅 trigger-user 鉴权会话',
  },

  // ───────── cross-listed: 会话开始 + 每条新消息 (new + followup) ──────────

  // <attachments> — outer hint (the [image N] list is generated)
  {
    key: 'ai.attach.hint', block: 'attachments', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '<attachments> 标签上的查看提示',
    gateLabel: '仅当本轮带附件时；首轮与每轮共用同一条文案',
  },
  // bare (transcript + solo) envelope-less folded labels
  {
    key: 'ai.bridge.attachments_label', block: 'envelope', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '折进正文的「附件」标签',
    gateLabel: '仅 transcript + solo 裸文本模式（附件折进正文）；首轮与每轮共用',
  },
  {
    key: 'ai.bridge.mentions_label', block: 'envelope', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '折进正文的「@提及」标签',
    gateLabel: '仅 transcript + solo 裸文本模式（提及折进正文）；首轮与每轮共用',
  },
  {
    key: 'ai.cursor.sender_note', block: 'sender_note', stage: 'new', stages: ['followup'], kind: 'editable',
    label: 'cursor：别把 sender 元信息抄进回复',
    gateLabel: '仅 cursor 适配器、且本轮存在 <sender> 标签时；首轮与每轮共用',
  },

  // optional context blocks
  {
    key: 'ai.chat_context.policy', block: 'chat_context', stage: 'new', kind: 'editable',
    label: '群名 / 群描述不可信声明',
    gateLabel: '仅会话配置了群名/群描述上下文时，随 <chat_context_policy> 注入（首轮）',
  },
  {
    key: 'ai.summary_memory.intro', block: 'summary_memory', stage: 'new', stages: ['followup'], kind: 'placeholder',
    placeholders: ['path'], label: '记忆：路径与用途说明',
    gateLabel: '仅该 bot 开启 summaryMemory（/summary 记忆）时；首轮与每轮共用',
  },
  {
    key: 'ai.summary_memory.read_rule', block: 'summary_memory', stage: 'new', stages: ['followup'], kind: 'placeholder',
    placeholders: ['path'], label: '记忆：先读取、再复用条件',
    gateLabel: '仅开启 summaryMemory 时',
  },
  {
    key: 'ai.summary_memory.reuse_guard', block: 'summary_memory', stage: 'new', stages: ['followup'], kind: 'placeholder',
    placeholders: ['path'], label: '记忆：条件不齐只能当参考',
    gateLabel: '仅开启 summaryMemory 时',
  },
  {
    key: 'ai.summary_memory.write_guard', block: 'summary_memory', stage: 'new', stages: ['followup'], kind: 'placeholder',
    placeholders: ['path'], label: '记忆：不得主动写文件',
    gateLabel: '仅开启 summaryMemory 时',
  },
  {
    key: 'ai.whiteboard.block_read', block: 'whiteboard_block', stage: 'new', stages: ['followup'], kind: 'placeholder',
    placeholders: ['id'], label: '白板：读取指令',
    gateLabel: '白板功能开启且会话绑定白板时；首轮与每轮共用',
  },
  {
    key: 'ai.whiteboard.block_update', block: 'whiteboard_block', stage: 'new', stages: ['followup'], kind: 'placeholder',
    placeholders: ['id'], label: '白板：更新指令（CAS 版本号）',
    gateLabel: '白板开启且绑定白板时',
  },
  {
    key: 'ai.whiteboard.block_rewrite', block: 'whiteboard_block', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '白板：融合重写规则', gateLabel: '白板开启且绑定白板时',
  },
  {
    key: 'ai.whiteboard.block_cas', block: 'whiteboard_block', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '白板：CAS 冲突处理', gateLabel: '白板开启且绑定白板时',
  },
  {
    key: 'ai.whiteboard.block_tail_send', block: 'whiteboard_block', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '白板：结尾安全条（标准 send 模式）', gateLabel: '白板开启且绑定白板时',
  },
  {
    key: 'ai.whiteboard.block_tail_transcript', block: 'whiteboard_block', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '白板：结尾安全条（transcript 模式）',
    gateLabel: '白板开启、绑定白板且 replyDelivery=transcript 时',
  },
  {
    key: 'ai.whiteboard.block_tail_no_transport', block: 'whiteboard_block', stage: 'new', stages: ['followup'], kind: 'editable',
    label: '白板：结尾安全条（no-transport 程序会话）',
    gateLabel: '白板开启、绑定白板且无传输会话（HTTP/apiOnly）时',
  },
  {
    key: 'ai.whiteboard.hint_send_shell', block: 'whiteboard_hints', stage: 'new', kind: 'editable',
    label: '白板单行：Shell 路径 · send 模式', gateLabel: '白板开启时随首轮 Shell 提示注入',
  },
  {
    key: 'ai.whiteboard.hint_transcript_shell', block: 'whiteboard_hints', stage: 'new', kind: 'editable',
    label: '白板单行：Shell 路径 · transcript 模式', gateLabel: '白板开启 + transcript，首轮 Shell 提示',
  },
  {
    key: 'ai.whiteboard.hint_send_system', block: 'whiteboard_hints', stage: 'new', kind: 'editable',
    label: '白板单行：系统提示路径 · send 模式', gateLabel: '白板开启时随首轮系统提示注入',
  },
  {
    key: 'ai.whiteboard.hint_transcript_system', block: 'whiteboard_hints', stage: 'new', kind: 'editable',
    label: '白板单行：系统提示路径 · transcript 模式', gateLabel: '白板开启 + transcript，首轮系统提示',
  },

  // ───────────────────── stage: 每条新消息 (followup) ──────────────────────

  { key: 'ai.followup.reminder', block: 'followup', stage: 'followup', label: '续轮提醒（默认）', kind: 'editable' },
  {
    key: 'ai.followup.reminder_hook', block: 'followup', stage: 'followup', kind: 'editable',
    label: '续轮提醒（Claude Code hook 离带注入版）',
    gateLabel: '仅 hook 模式：reminder 经 system-reminder 离带注入，使用描述式措辞',
  },
  {
    key: 'ai.followup.reminder_no_resend', block: 'followup', stage: 'followup',
    label: '续轮提醒（防重发版）',
    kind: 'conditional', gate: 'dashboard.noVisibleOutputHint',
    gateLabel: '实验开关「无可见输出防重发」开启时代替默认版；也可用右侧下拉强制开/关',
  },
  {
    key: 'ai.followup.reminder_no_transport', block: 'followup', stage: 'followup', kind: 'editable',
    label: '续轮提醒（no-transport 程序会话）',
    gateLabel: '仅无传输会话（HTTP 虚拟会话 / apiOnly bot）',
  },
  {
    key: 'xpi.replay.prompt', block: 'xpi_replay', stage: 'followup', kind: 'placeholder',
    placeholders: ['ownerTask', 'suggestion'],
    label: 'XPI 建议采纳后重跑原任务的提示',
    gateLabel: 'XPI 建议被发起人确认、重新执行原任务时',
  },

  // ───────────────────────── stage: 发送之后 (send) ────────────────────────

  {
    key: 'ai.send.after_success_hint', block: 'send_feedback', stage: 'send', kind: 'editable',
    label: 'send 成功后的常规回显',
  },
  {
    key: 'ai.send.after_success_unified', block: 'send_feedback', stage: 'send', kind: 'editable',
    label: '统一回复卡片：进度已更新回显',
    gateLabel: '仅本轮发送走统一回复卡片、且未标记 --response-kind final 时',
  },
];

const FRAGMENT_BY_KEY = new Map(PROMPT_FRAGMENTS.map((f) => [f.key, f]));

export function getFragmentSpec(key: string): PromptFragmentSpec | undefined {
  return FRAGMENT_BY_KEY.get(key);
}

/** All stages a fragment renders at. */
export function fragmentStages(f: PromptFragmentSpec): PromptStage[] {
  return f.stages && f.stages.length > 0 ? [f.stage, ...f.stages] : [f.stage];
}

/** All fragment keys that are overridable text (excludes pure conditional gates
 *  which are boolean, not text). Conditional keys ARE still text-overridable too
 *  — they have a rendered string — so they're included. */
export function overridableFragmentKeys(): string[] {
  return PROMPT_FRAGMENTS.map((f) => f.key);
}

/** True if `key` is a known conditional-line fragment. */
export function isConditionalFragment(key: string): boolean {
  return FRAGMENT_BY_KEY.get(key)?.kind === 'conditional';
}

/**
 * Validate a candidate override value for a fragment. For placeholder fragments
 * every declared `{token}` must still be present, else the runtime interpolation
 * would silently drop a real value (bot count / names, file path, board id).
 * Returns an error string, or undefined when the value is acceptable.
 */
export function validateFragmentOverride(key: string, value: string): string | undefined {
  const spec = FRAGMENT_BY_KEY.get(key);
  if (!spec) return undefined; // unknown key: no placeholder contract to enforce
  if (spec.kind === 'placeholder' && spec.placeholders) {
    for (const token of spec.placeholders) {
      if (!value.includes(`{${token}}`)) {
        return `缺少占位符 {${token}}：删除后运行时无法填入实际值`;
      }
    }
  }
  return undefined;
}

/** The shipped (factory) rendered string for a fragment key + locale. Used by
 *  the CLI/dashboard to prefill editors and compute "modified" state. Reads
 *  through `t()` — but callers must ensure the override resolver is NOT masking
 *  it; see {@link shippedFragmentText} which bypasses overrides. */
export function currentFragmentText(key: string, locale: Locale): string {
  return t(key, undefined, locale);
}
