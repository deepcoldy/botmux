import { SEND_SKILL } from './definitions.js';

/**
 * The subset of per-bot replyStyle that changes botmux-send's writing guide.
 * The worker freezes the normalized sparse object into BOTMUX_REPLY_STYLE for
 * the lifetime of a session. Keep this parser deliberately fail-soft: a stale
 * or hand-written env value must never make `botmux skill show` unusable.
 */
export interface ReplyStyleGuideConfig {
  recipes?: boolean;
  layout?: boolean;
  theme?: 'default' | 'minimal' | 'vivid';
  recipePrompt?: string;
  layoutColors?: Record<string, string>;
  layoutTags?: Record<string, string>;
}

const RECIPE_START = '### 可选排版配方（参考，不是强制模板）';
const RECIPE_END = '## 卡住了需要人介入：`--attention`';
const SESSION_STYLE_ENV = 'BOTMUX_REPLY_STYLE';

const LAYOUT_GUIDE = `### 可选语义卡头：\`--layout\`

\`--layout\` 只在对用户有明确意义的关键节点使用，不是每条回复的固定外壳。单句确认、简短状态和无实质进展的消息不要加卡头。

| 关键节点 | 参数 |
|---|---|
| 完成并交付结果 | \`--layout result\` |
| 长任务到达值得同步的里程碑 | \`--layout progress\` |
| 有风险或需要用户拍板 | \`--layout risk\` |
| 任务失败或被硬阻塞、需要人介入 | \`--layout blocked\`（并按下文判断是否加 \`--attention\`） |
| 真正把任务交给下一个 Agent 或人 | \`--layout handoff\` |

例：\`botmux send --layout result --mention-back "已交付，验证全绿。"\`。卡头表达语义，正文仍是自由 Markdown；不要根据正文自行猜测档位，也不要为了颜色而套壳。若正文有 H1/H2，第一个会进入卡头标题，因此这一行只写纯文字，不放内联 @、链接或其它 Markdown 语法。`;

/** Stable content written to shared/native skill directories. */
export const SEND_SKILL_SESSION_LOADER = `---
name: botmux-send
description: 向飞书话题发送消息。复杂排版、附件、卡片、@mention、跨群发布或 --attention 前必须先读取当前会话的完整指南。
---

# botmux-send — 读取当前会话指南

这个入口只是稳定的共享加载器，不包含任何 Bot 的个性化配置。首次使用前，必须在当前 botmux 会话的 shell 中运行：

\`\`\`bash
botmux skill show botmux-send
\`\`\`

命令输出的完整 SKILL.md 才是当前会话的权威指南；按它执行，不要从这个加载器猜测排版配方或卡头开关。
`;

export function parseReplyStyleGuideConfig(
  raw: string | undefined,
): ReplyStyleGuideConfig {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as ReplyStyleGuideConfig;
  } catch {
    return {};
  }
}

function replaceBetween(source: string, start: string, end: string, replacement: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) return source;
  const before = source.slice(0, from).trimEnd();
  const after = source.slice(to).trimStart();
  return replacement.trim()
    ? `${before}\n\n${replacement.trim()}\n\n${after}`
    : `${before}\n\n${after}`;
}

function addLayoutParameterRow(source: string): string {
  const anchor = '| \`--session-id <id>\` | 手动指定 session（通常自动推断，不需要传） |';
  const row = '| \`--layout <result\\|progress\\|risk\\|blocked\\|handoff>\` | 可选语义卡头；只用于关键节点 |';
  return source.includes(anchor) ? source.replace(anchor, `${row}\n${anchor}`) : source;
}

/**
 * A custom recipe remains authoritative, except that it cannot advertise a
 * runtime capability the bot owner explicitly disabled. Drop only conflicting
 * lines so unrelated custom guidance survives and the rendered guide contains
 * no misleading layout invocation.
 */
function customRecipeForLayoutGate(source: string, layoutEnabled: boolean): string {
  if (layoutEnabled || !source.includes('--layout')) return source;
  return source
    .split('\n')
    .filter(line => !line.includes('--layout'))
    .join('\n')
    .trim();
}

/**
 * Render the factory botmux-send guide for one session. User-overridden skill
 * bodies bypass this function at the caller, preserving customization priority.
 */
export function renderBotmuxSendSkill(
  env: Record<string, string | undefined> = process.env,
): string {
  const style = parseReplyStyleGuideConfig(env[SESSION_STYLE_ENV]);
  const recipesEnabled = style.recipes !== false;
  const layoutEnabled = style.layout !== false;

  let recipeSection = '';
  if (recipesEnabled) {
    const custom = typeof style.recipePrompt === 'string' ? style.recipePrompt.trim() : '';
    if (custom) recipeSection = customRecipeForLayoutGate(custom, layoutEnabled);
    else {
      const from = SEND_SKILL.indexOf(RECIPE_START);
      const to = SEND_SKILL.indexOf(RECIPE_END, from + RECIPE_START.length);
      recipeSection = from >= 0 && to >= 0 ? SEND_SKILL.slice(from, to).trim() : '';
    }
  }

  const sections = [recipeSection, layoutEnabled ? LAYOUT_GUIDE : ''].filter(Boolean).join('\n\n');
  const rendered = replaceBetween(SEND_SKILL, RECIPE_START, RECIPE_END, sections);
  return layoutEnabled ? addLayoutParameterRow(rendered) : rendered;
}
