/**
 * 决策看板公告的轻量飞书卡片：只负责群内展示，不改写送进管家会话的纯文本。
 * 链接文字统一转义，链接地址藏在 Markdown 目标里；超过卡片预算时由调用方沿用原文降级。
 */

/** 与拍板卡片共用 24KB 预算，给飞书 30KB 请求体上限留出包装余量。 */
export const NOTICE_CARD_MAX_BYTES = 24_000;

/** 卡片 Markdown 里的动态文本；方括号、括号等不能让事项标题伪造链接或格式。 */
export function escapeNoticeMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\*_~`[\]()])/g, '\\$1');
}

/** 事项 / 主群的可点击文案；没有合法的 HTTP(S) 地址时只显示转义后的文字。 */
export function noticeMarkdownLink(text: string, url?: string): string {
  const label = escapeNoticeMarkdown(text);
  const href = url?.trim();
  if (!href || !/^https?:\/\/\S+$/i.test(href)) return label;
  // 飞书 Markdown 用括号界定目标；生成地址通常已编码，这里兜底避免括号截断链接。
  const safeHref = href.replace(/\\/g, '%5C').replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${label}](${safeHref})`;
}

export function noticeItemLink(seq: number, title: string, url?: string): string {
  return noticeMarkdownLink(`#${seq} ${title.replace(/\s+/g, ' ').trim()}`, url);
}

/**
 * 一张只读的紧凑公告卡片。返回可直接交给 msg_type=interactive 的 JSON；
 * 超长返回 undefined，调用方必须走既有纯文本，而不是截断 owner 的内容。
 */
export function compactNoticeCard(input: {
  title: string;
  lines: readonly string[];
  footer?: string;
  template?: 'blue' | 'grey';
}): string | undefined {
  const elements: unknown[] = [{ tag: 'markdown', content: input.lines.join('\n') }];
  if (input.footer) elements.push({ tag: 'markdown', content: `<font color='grey'>${input.footer}</font>` });
  const card = {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'fill' },
    header: { title: { tag: 'plain_text', content: input.title }, template: input.template ?? 'blue' },
    body: { direction: 'vertical', elements },
  };
  const json = JSON.stringify(card);
  return Buffer.byteLength(json, 'utf8') <= NOTICE_CARD_MAX_BYTES ? json : undefined;
}
