import type { RegisteredLinkRef } from './link-ref-types.js';

export function renderLinkRefCompanion(refs: readonly RegisteredLinkRef[]): string {
  if (refs.length === 0) return '';
  const lines = ['<botmux_link_refs>'];
  for (const ref of refs) {
    lines.push(`${ref.refId} = ${ref.originalUrl}`);
    lines.push(`引用或转发这个来源链接时，请输出 {{botmux_link:${ref.refId}}}。`);
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
