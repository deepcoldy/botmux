import {
  REPLY_LAYOUTS,
  normalizeReplyStyleConfig,
  type ReplyHeaderColor,
  type ReplyLayout,
  type ReplyStyleConfig,
  type ReplyTheme,
} from '../../im/lark/reply-card-style.js';

export type ReplyTagMode = 'inherit' | 'hidden' | 'custom';

export interface ReplyStyleDraft {
  recipes: boolean;
  layout: boolean;
  theme: ReplyTheme;
  recipePrompt: string;
  layoutColors: Record<ReplyLayout, ReplyHeaderColor | ''>;
  layoutTagModes: Record<ReplyLayout, ReplyTagMode>;
  layoutTags: Record<ReplyLayout, string>;
}

/**
 * HTML `maxLength` counts UTF-16 code units, while the shared reply-style
 * contract counts Unicode code points. Clamp in model space so astral symbols
 * (emoji, some historic scripts) receive the same limit in Dashboard and in
 * the daemon normalizer.
 */
export function clampUnicodeCodePoints(value: string, max: number): string {
  if (max <= 0) return '';
  let count = 0;
  let end = 0;
  for (const codePoint of value) {
    if (count >= max) break;
    count += 1;
    end += codePoint.length;
  }
  return end === value.length ? value : value.slice(0, end);
}

function layoutRecord<T>(value: (layout: ReplyLayout) => T): Record<ReplyLayout, T> {
  return Object.fromEntries(REPLY_LAYOUTS.map(layout => [layout, value(layout)])) as Record<ReplyLayout, T>;
}

/** Convert a hand-edited or older payload to the explicit state the form needs. */
export function replyStyleDraftFromConfig(raw: unknown): ReplyStyleDraft {
  const config = normalizeReplyStyleConfig(raw).config;
  return {
    recipes: config?.recipes ?? true,
    layout: config?.layout ?? true,
    theme: config?.theme ?? 'default',
    recipePrompt: config?.recipePrompt ?? '',
    layoutColors: layoutRecord(layout => config?.layoutColors?.[layout] ?? ''),
    layoutTagModes: layoutRecord(layout => {
      if (!config?.layoutTags || !Object.prototype.hasOwnProperty.call(config.layoutTags, layout)) return 'inherit';
      return config.layoutTags[layout] === '' ? 'hidden' : 'custom';
    }),
    layoutTags: layoutRecord(layout => config?.layoutTags?.[layout] ?? ''),
  };
}

/**
 * Serialize the form back to a sparse bots.json override. Built-in defaults and
 * per-layout inheritance are omitted; an explicit hidden tag remains `''`.
 */
export function replyStyleConfigFromDraft(draft: ReplyStyleDraft): ReplyStyleConfig | undefined {
  const raw: ReplyStyleConfig = {};
  if (!draft.recipes) raw.recipes = false;
  if (!draft.layout) raw.layout = false;
  if (draft.theme !== 'default') raw.theme = draft.theme;
  if (draft.recipePrompt.trim()) raw.recipePrompt = draft.recipePrompt.trim();

  const colors: ReplyStyleConfig['layoutColors'] = {};
  const tags: ReplyStyleConfig['layoutTags'] = {};
  for (const layout of REPLY_LAYOUTS) {
    const color = draft.layoutColors[layout];
    if (color) colors[layout] = color;

    const tagMode = draft.layoutTagModes[layout];
    if (tagMode === 'hidden') tags[layout] = '';
    else if (tagMode === 'custom') tags[layout] = draft.layoutTags[layout].trim();
  }
  if (Object.keys(colors).length > 0) raw.layoutColors = colors;
  if (Object.keys(tags).length > 0) raw.layoutTags = tags;

  // The daemon owns canonical validation and returns per-field warnings. Keep
  // the browser serializer sparse, but do not silently pre-drop a value that
  // bypassed HTML constraints (for example through a hand-edited request).
  return Object.keys(raw).length > 0 ? raw : undefined;
}

export function replyStyleDraftHasBlankCustomTag(draft: ReplyStyleDraft): boolean {
  return REPLY_LAYOUTS.some(layout => (
    draft.layoutTagModes[layout] === 'custom' && !draft.layoutTags[layout].trim()
  ));
}
