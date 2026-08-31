/**
 * Bot reply-card layout vocabulary and Card 2.0 header builder.
 *
 * This module is deliberately browser-safe: Dashboard code, bot config
 * parsing, the CLI send path, and tests can share the exact same enums without
 * importing Node-only registry or transport code.
 */

export const REPLY_LAYOUTS = [
  'result',
  'progress',
  'risk',
  'blocked',
  'handoff',
] as const;

export type ReplyLayout = typeof REPLY_LAYOUTS[number];

export const REPLY_THEMES = ['default', 'minimal', 'vivid'] as const;
export type ReplyTheme = typeof REPLY_THEMES[number];

/** Keep the spawn-time JSON env comfortably below OS per-entry limits even
 * for four-byte Unicode, while leaving ample room for a custom recipe guide. */
export const REPLY_RECIPE_PROMPT_MAX_CODEPOINTS = 4096;
/** Header tags are deliberately short labels, not another body text channel. */
export const REPLY_LAYOUT_TAG_MAX_CODEPOINTS = 32;

/** Official Feishu/Lark Card 2.0 `header.template` palette. */
export const REPLY_HEADER_COLORS = [
  'blue',
  'wathet',
  'turquoise',
  'green',
  'yellow',
  'orange',
  'red',
  'carmine',
  'violet',
  'purple',
  'indigo',
  'grey',
] as const;

export type ReplyHeaderColor = typeof REPLY_HEADER_COLORS[number];

/** Official Card header `text_tag.color` palette. It differs from the header
 * template palette: tags use `neutral`/`lime` and do not accept `grey`. */
export const REPLY_TEXT_TAG_COLORS = [
  'neutral',
  'blue',
  'turquoise',
  'lime',
  'orange',
  'violet',
  'indigo',
  'wathet',
  'green',
  'yellow',
  'red',
  'purple',
  'carmine',
] as const;

export type ReplyTextTagColor = typeof REPLY_TEXT_TAG_COLORS[number];

/** Sparse per-bot overrides persisted under `BotConfig.replyStyle`. */
export interface ReplyStyleConfig {
  recipes?: boolean;
  layout?: boolean;
  theme?: ReplyTheme;
  recipePrompt?: string;
  layoutColors?: Partial<Record<ReplyLayout, ReplyHeaderColor>>;
  /** Missing key inherits the theme; an explicit empty string hides the tag. */
  layoutTags?: Partial<Record<ReplyLayout, string>>;
}

export interface ReplyCardTextTag {
  tag: 'text_tag';
  color: ReplyTextTagColor;
  text: {
    tag: 'plain_text';
    content: string;
  };
}

export interface ReplyCardHeader {
  title: {
    tag: 'plain_text';
    content: string;
  };
  template?: ReplyHeaderColor;
  text_tag_list?: ReplyCardTextTag[];
}

/** Semantic prefixes are fixed; only an explicitly selected layout can add
 * one. The first eligible body heading may personalise the rest of the title
 * but never selects or changes the layout. */
export const DEFAULT_REPLY_LAYOUT_TITLES: Readonly<Record<ReplyLayout, string>> = {
  result: '结果',
  progress: '进度',
  risk: '需要确认',
  blocked: '受阻',
  handoff: '交接',
};

export const DEFAULT_REPLY_LAYOUT_COLORS: Readonly<Record<ReplyLayout, ReplyHeaderColor>> = {
  result: 'green',
  progress: 'blue',
  risk: 'orange',
  blocked: 'red',
  handoff: 'indigo',
};

/** Empty string means the default theme intentionally renders no tag. */
export const DEFAULT_REPLY_LAYOUT_TAGS: Readonly<Record<ReplyLayout, string>> = {
  result: '',
  progress: '',
  risk: '需要你',
  blocked: '需要你',
  handoff: '',
};

export const VIVID_REPLY_LAYOUT_TAGS: Readonly<Record<ReplyLayout, string>> = {
  result: '完成',
  progress: '进行中',
  risk: '需要你',
  blocked: '需要你',
  handoff: '交接',
};

/** Text-tag colors are semantic and stay stable when a custom header color is
 * applied. This prevents a cosmetic header override from turning an attention
 * label green or a completion label red. */
export const REPLY_LAYOUT_TAG_COLORS: Readonly<Record<ReplyLayout, ReplyTextTagColor>> = {
  result: 'green',
  progress: 'blue',
  risk: 'red',
  blocked: 'red',
  handoff: 'indigo',
};

export function isReplyLayout(value: unknown): value is ReplyLayout {
  return typeof value === 'string' && (REPLY_LAYOUTS as readonly string[]).includes(value);
}

export function isReplyTheme(value: unknown): value is ReplyTheme {
  return typeof value === 'string' && (REPLY_THEMES as readonly string[]).includes(value);
}

export function isReplyHeaderColor(value: unknown): value is ReplyHeaderColor {
  return typeof value === 'string' && (REPLY_HEADER_COLORS as readonly string[]).includes(value);
}

export function isReplyTextTagColor(value: unknown): value is ReplyTextTagColor {
  return typeof value === 'string' && (REPLY_TEXT_TAG_COLORS as readonly string[]).includes(value);
}

export interface NormalizedReplyStyleResult {
  /** Sparse validated override. Undefined means the entire block is default. */
  config?: ReplyStyleConfig;
  warnings: string[];
}

export interface ResolvedReplyLayoutStyle {
  /** Omitted for the minimal theme unless an explicit color override exists. */
  template?: ReplyHeaderColor;
  /** Omitted when the theme/override intentionally hides the tag. */
  tag?: string;
  tagColor: ReplyTextTagColor;
}

export interface ResolvedReplyStyle {
  recipes: boolean;
  layout: boolean;
  theme: ReplyTheme;
  /** A nonblank custom replacement for the built-in recipe section. */
  recipePrompt?: string;
  layouts: Record<ReplyLayout, ResolvedReplyLayoutStyle>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exceedsCodePointLimit(value: string, max: number): boolean {
  let count = 0;
  for (const _ of value) {
    count += 1;
    if (count > max) return true;
  }
  return false;
}

/**
 * Validate a hand-edited bots.json block without turning cosmetic mistakes
 * into daemon/send failures. Invalid fields are dropped one by one and the
 * caller decides where to log the returned diagnostics.
 */
export function normalizeReplyStyleConfig(raw: unknown): NormalizedReplyStyleResult {
  if (raw === undefined || raw === null) return { warnings: [] };
  if (!isRecord(raw)) {
    return { warnings: ['replyStyle 必须是对象，已忽略并使用缺省回复风格'] };
  }

  const warnings: string[] = [];
  const config: ReplyStyleConfig = {};
  for (const key of ['recipes', 'layout'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value === 'boolean') config[key] = value;
    else warnings.push(`replyStyle.${key} 必须是 boolean，已忽略`);
  }

  if (raw.theme !== undefined) {
    if (isReplyTheme(raw.theme)) config.theme = raw.theme;
    else warnings.push(`replyStyle.theme 不支持“${String(raw.theme)}”，已回退 default`);
  }

  if (raw.recipePrompt !== undefined) {
    if (typeof raw.recipePrompt !== 'string') {
      warnings.push('replyStyle.recipePrompt 必须是 string，已忽略');
    } else {
      const prompt = raw.recipePrompt.trim();
      if (prompt.includes('\0')) {
        warnings.push('replyStyle.recipePrompt 不能包含 NUL，已忽略');
      } else if (exceedsCodePointLimit(prompt, REPLY_RECIPE_PROMPT_MAX_CODEPOINTS)) {
        warnings.push(`replyStyle.recipePrompt 不能超过 ${REPLY_RECIPE_PROMPT_MAX_CODEPOINTS} 个 Unicode 字符，已忽略`);
      } else if (prompt) {
        config.recipePrompt = prompt;
      }
    }
  }

  if (raw.layoutColors !== undefined) {
    if (!isRecord(raw.layoutColors)) {
      warnings.push('replyStyle.layoutColors 必须是对象，已忽略');
    } else {
      const colors: Partial<Record<ReplyLayout, ReplyHeaderColor>> = {};
      for (const [rawLayout, color] of Object.entries(raw.layoutColors)) {
        if (!isReplyLayout(rawLayout)) {
          warnings.push(`replyStyle.layoutColors.${rawLayout} 不是支持的 layout，已忽略`);
          continue;
        }
        if (!isReplyHeaderColor(color)) {
          warnings.push(`replyStyle.layoutColors.${rawLayout} 不是官方颜色，已忽略`);
          continue;
        }
        if (rawLayout === 'handoff' && color === 'grey') {
          warnings.push('replyStyle.layoutColors.handoff 不允许 grey，已回退主题颜色');
          continue;
        }
        colors[rawLayout] = color;
      }
      if (Object.keys(colors).length > 0) config.layoutColors = colors;
    }
  }

  if (raw.layoutTags !== undefined) {
    if (!isRecord(raw.layoutTags)) {
      warnings.push('replyStyle.layoutTags 必须是对象，已忽略');
    } else {
      const tags: Partial<Record<ReplyLayout, string>> = {};
      for (const [rawLayout, tag] of Object.entries(raw.layoutTags)) {
        if (!isReplyLayout(rawLayout)) {
          warnings.push(`replyStyle.layoutTags.${rawLayout} 不是支持的 layout，已忽略`);
          continue;
        }
        if (typeof tag !== 'string') {
          warnings.push(`replyStyle.layoutTags.${rawLayout} 必须是 string，已忽略`);
          continue;
        }
        const normalizedTag = tag.trim();
        if (/\p{Cc}/u.test(normalizedTag)) {
          warnings.push(`replyStyle.layoutTags.${rawLayout} 不能包含控制字符，已忽略`);
          continue;
        }
        if (exceedsCodePointLimit(normalizedTag, REPLY_LAYOUT_TAG_MAX_CODEPOINTS)) {
          warnings.push(`replyStyle.layoutTags.${rawLayout} 不能超过 ${REPLY_LAYOUT_TAG_MAX_CODEPOINTS} 个 Unicode 字符，已忽略`);
          continue;
        }
        // Missing key inherits; an explicit empty string intentionally hides.
        tags[rawLayout] = normalizedTag;
      }
      if (Object.keys(tags).length > 0) config.layoutTags = tags;
    }
  }

  return Object.keys(config).length > 0
    ? { config, warnings }
    : { warnings };
}

export function resolveReplyStyle(config?: ReplyStyleConfig): ResolvedReplyStyle {
  const theme = config?.theme ?? 'default';
  const themeTags = theme === 'vivid'
    ? VIVID_REPLY_LAYOUT_TAGS
    : DEFAULT_REPLY_LAYOUT_TAGS;
  const layouts = Object.fromEntries(REPLY_LAYOUTS.map(layout => {
    const template = config?.layoutColors?.[layout]
      ?? (theme === 'minimal' ? undefined : DEFAULT_REPLY_LAYOUT_COLORS[layout]);
    const tag = config?.layoutTags && Object.prototype.hasOwnProperty.call(config.layoutTags, layout)
      ? config.layoutTags[layout]
      : themeTags[layout];
    return [layout, {
      ...(template ? { template } : {}),
      ...(tag ? { tag } : {}),
      tagColor: REPLY_LAYOUT_TAG_COLORS[layout],
    } satisfies ResolvedReplyLayoutStyle];
  })) as Record<ReplyLayout, ResolvedReplyLayoutStyle>;
  return {
    recipes: config?.recipes ?? true,
    layout: config?.layout ?? true,
    theme,
    ...(config?.recipePrompt ? { recipePrompt: config.recipePrompt } : {}),
    layouts,
  };
}

export interface ReplyLayoutRequest {
  /** Whether any `--layout` spelling was present. */
  present: boolean;
  /** Set only for one well-formed, supported layout request. */
  layout?: ReplyLayout;
  /** Human-readable fail-soft diagnostic for stderr. */
  warning?: string;
}

const LAYOUT_USAGE = REPLY_LAYOUTS.join('|');

/**
 * Parse `--layout value` / `--layout=value` without letting a missing value
 * consume the next flag. Invalid, empty, or duplicate requests deliberately
 * fall back to the ordinary reply card instead of failing the send.
 */
export function parseReplyLayoutRequest(args: readonly string[]): ReplyLayoutRequest {
  const occurrences: Array<{ token: string; index: number }> = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (token === '--layout' || token.startsWith('--layout=')) {
      occurrences.push({ token, index });
    }
  }
  if (occurrences.length === 0) return { present: false };

  const warning = (detail: string): ReplyLayoutRequest => ({
    present: true,
    warning: `botmux send: --layout ${detail}，已忽略并按普通回复卡发送（支持 ${LAYOUT_USAGE}）`,
  });
  if (occurrences.length !== 1) return warning('只能指定一次');

  const [{ token, index }] = occurrences;
  const value = token === '--layout'
    ? args[index + 1]
    : token.slice('--layout='.length);
  if (!value || value.startsWith('--')) return warning('缺少有效名称');
  if (!isReplyLayout(value)) return warning(`不支持“${value}”`);
  return { present: true, layout: value };
}

function normalizedTitleForDedup(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s·:：,，.。、!！?？\-—_\/\\|()[\]{}（）【】]/g, '');
}

function isRepeatedLayoutPrefix(subject: string, prefix: string): boolean {
  const normalizedSubject = normalizedTitleForDedup(subject);
  const normalizedPrefix = normalizedTitleForDedup(prefix);
  if (!normalizedSubject || !normalizedPrefix) return false;
  if (normalizedSubject.length % normalizedPrefix.length !== 0) return false;
  return normalizedSubject === normalizedPrefix.repeat(
    normalizedSubject.length / normalizedPrefix.length,
  );
}

/**
 * Build the finalised default-theme Card 2.0 header for one explicit layout.
 * The optional heading comes only from the first top-level ATX H1/H2 selected
 * by the markdown builder; it personalises the title but never selects the
 * layout. A heading that merely repeats the prefix is suppressed.
 */
export function buildReplyLayoutHeader(
  layout: ReplyLayout,
  heading?: string,
  style: ResolvedReplyStyle = resolveReplyStyle(),
): ReplyCardHeader {
  const layoutStyle = style.layouts[layout];
  const tagText = layoutStyle.tag;
  const tagColor = isReplyTextTagColor(layoutStyle.tagColor)
    ? layoutStyle.tagColor
    : 'neutral';
  const prefix = DEFAULT_REPLY_LAYOUT_TITLES[layout];
  const subject = heading?.trim();
  const title = subject && !isRepeatedLayoutPrefix(subject, prefix)
    ? `${prefix} · ${subject}`
    : prefix;
  return {
    ...(layoutStyle.template ? { template: layoutStyle.template } : {}),
    title: {
      tag: 'plain_text',
      content: title,
    },
    ...(tagText
      ? {
          text_tag_list: [{
            tag: 'text_tag' as const,
            color: tagColor,
            text: { tag: 'plain_text' as const, content: tagText },
          }],
        }
      : {}),
  };
}

/** Backward-compatible default-theme helper used by the first implementation
 * block and external callers that do not need per-bot configuration. */
export function buildDefaultReplyLayoutHeader(
  layout: ReplyLayout,
  heading?: string,
): ReplyCardHeader {
  return buildReplyLayoutHeader(layout, heading);
}
