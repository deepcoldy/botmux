import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { slugFromWorktreeText } from './git-worktree.js';

const SYSTEM_PROMPT = `You generate short, stable git branch slugs for coding tasks.
Return ONLY one lowercase ASCII slug, no markdown, no quotes.
Rules:
- Translate Chinese or any non-English task into concise English keywords.
- Use 2 to 5 words when possible.
- Use only a-z, 0-9, and hyphen.
- Start and end with a letter or digit.
- Max 48 characters.
- Prefer concrete engineering terms over generic words.
Examples:
中文 worktree 命名逻辑 -> worktree-naming-logic
远端同名分支已存在时 checkout 逻辑 -> remote-branch-checkout
创建 PR 前自动跑测试 -> pre-pr-test-run
修复飞书卡片重复点击 -> lark-card-double-click`;

function firstText(title?: string, firstPrompt?: string): string | undefined {
  const t = title?.trim();
  if (t) return t;
  const p = firstPrompt?.trim();
  return p || undefined;
}

function sanitizeModelSlug(raw: string | undefined): string | undefined {
  return slugFromWorktreeText(raw)?.slice(0, 48).replace(/-+$/g, '') || undefined;
}

function aiSlugConfigured(): boolean {
  const c = config.worktreeSlugAI;
  return !!(c?.enabled && c.baseUrl && c.apiKey && c.model);
}

export function localWorktreeSlugFromContext(title?: string, firstPrompt?: string): string | undefined {
  return slugFromWorktreeText(title) ?? slugFromWorktreeText(firstPrompt);
}

export async function worktreeSlugFromContextAI(title?: string, firstPrompt?: string): Promise<string | undefined> {
  const fallback = localWorktreeSlugFromContext(title, firstPrompt);
  if (!aiSlugConfigured()) return fallback;

  const text = firstText(title, firstPrompt);
  if (!text) return fallback;

  const c = config.worktreeSlugAI;
  if (!c) return fallback;
  try {
    const url = `${c.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.apiKey}`,
        ...c.extraHeaders,
      },
      body: JSON.stringify({
        model: c.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, 1_000) },
        ],
        temperature: 0,
        max_tokens: 32,
        ...c.extraBody,
      }),
      signal: AbortSignal.timeout(Math.max(500, c.timeoutMs)),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`AI slug API ${resp.status}: ${body.slice(0, 200)}`);
    }
    const json = await resp.json() as any;
    const content = json?.choices?.[0]?.message?.content;
    const slug = sanitizeModelSlug(typeof content === 'string' ? content : undefined);
    if (slug) return slug;
    logger.warn('[worktree-slug-ai] empty or invalid AI slug, using local fallback');
  } catch (e) {
    logger.warn(`[worktree-slug-ai] failed, using local fallback: ${e instanceof Error ? e.message : e}`);
  }
  return fallback;
}
