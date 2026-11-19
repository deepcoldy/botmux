import { LINK_REF_MAX_COMPANION_URLS, type RegisteredLinkRef } from './link-ref-types.js';

export function renderLinkRefCompanion(
  refs: readonly RegisteredLinkRef[],
  options: { limited?: number } = {},
): string {
  if (refs.length === 0 && !options.limited) return '';
  const lines = ['<botmux_link_refs>'];
  const presented = refs.slice(0, LINK_REF_MAX_COMPANION_URLS);
  for (const ref of presented) {
    lines.push(`${ref.refId} = ${ref.originalUrl}`);
    lines.push(`引用或转发这个来源链接时，请输出 {{botmux_link:${ref.refId}}}。`);
  }
  if (presented.length < refs.length) {
    lines.push(`另有 ${refs.length - presented.length} 条来源链接已登记，仅省略引用映射展示；可逐字使用工具结果中的完整原始 URL。`);
  }
  if (options.limited) {
    lines.push(`${options.limited} 条来源链接超过本轮登记容量，无法完整校验；最终发送可能报 link_ref_limit_exceeded。请缩小查询范围，在新一轮重试，不得改写链接或绕过校验。`);
  }
  lines.push('如果有意只讨论域名或 base URL，可以直接输出普通 URL。');
  lines.push('</botmux_link_refs>');
  return lines.join('\n');
}

export function appendToolLinkRefCompanion<T extends object>(
  value: T,
  refs: readonly RegisteredLinkRef[] | string,
): T {
  const companion = typeof refs === 'string' ? refs : renderLinkRefCompanion(refs);
  if (!companion) return value;
  const content = 'content' in value && Array.isArray(value.content)
    ? value.content
    : [];
  return {
    ...value,
    content: [...content, { type: 'text', text: companion }],
  };
}

export function appendResourceLinkRefCompanion<T extends { contents?: unknown[] }>(
  value: T,
  refs: readonly RegisteredLinkRef[] | string,
): T {
  const companion = typeof refs === 'string' ? refs : renderLinkRefCompanion(refs);
  if (!companion) return value;
  return {
    ...value,
    contents: [
      ...(value.contents ?? []),
      {
        uri: 'botmux://link-refs/current-turn',
        mimeType: 'text/plain',
        text: companion,
      },
    ],
  };
}
