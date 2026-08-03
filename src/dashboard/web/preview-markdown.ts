// Markdown rendering for dashboard session-card exchange previews.
//
// Bot replies posted via `botmux send` are Markdown; the preview overlay
// renders them so `**bold**` / `` `code` `` / lists / links read as formatting
// instead of raw syntax. Mirrors the hardening of insights.ts's prompt
// renderer (html:false blocks raw HTML injection, links open in a new tab with
// noopener) but is kept standalone so the sessions page doesn't pull in the
// insights model module.
import MarkdownIt from 'markdown-it';
import { escapeHtml } from './ui.js';

const previewMd = new MarkdownIt({ html: false, linkify: true, breaks: true });
previewMd.validateLink = (url: string) => /^(https?:|mailto:)/i.test(url.trim());
const linkOpen = previewMd.renderer.rules.link_open;
previewMd.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet('target', '_blank');
  tokens[idx]!.attrSet('rel', 'noopener noreferrer nofollow');
  return linkOpen ? linkOpen(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
};
// Markdown image tokens (`![alt](url)`) are NOT covered by `html:false` — they
// still emit `<img src=…>`. The overlay auto-opens on hover/focus, so any
// user's prompt or a bot reply could make an operator's browser silently fetch
// an arbitrary external (tracking pixel) or internal (SSRF) URL. Never emit an
// auto-loading `<img>`: render a plain, non-fetching text placeholder that
// carries the alt text and, for a safe scheme, a click-through link the
// operator opts into.
previewMd.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]!;
  const alt = token.children?.reduce((acc, child) => acc + (child.content ?? ''), '') ?? '';
  const label = escapeHtml(alt.trim() || 'image');
  const src = token.attrGet('src') ?? '';
  const safe = /^(https?:|mailto:)/i.test(src.trim());
  if (safe) {
    return `<span class="session-card-exchange-img">🖼 <a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a></span>`;
  }
  return `<span class="session-card-exchange-img">🖼 ${label}</span>`;
};

/** Render preview Markdown to sanitized HTML. Raw HTML is disabled at the
 *  parser level; on any failure we fall back to an escaped plain-text
 *  paragraph so a malformed marker can never break the card. */
export function previewMarkdownHtml(text: string): string {
  const source = String(text ?? '');
  if (!source.trim()) return '';
  try {
    const html = previewMd.render(source).trim();
    return html || `<p>${escapeHtml(source)}</p>`;
  } catch {
    return `<p>${escapeHtml(source)}</p>`;
  }
}
