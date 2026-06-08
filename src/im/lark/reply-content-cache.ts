/**
 * File-based cache for AI reply content, keyed by a short unique string.
 * Card action buttons carry this key instead of the full content (which
 * can be 10k+ chars and would exceed Feishu's value size limit).
 *
 * Uses the filesystem instead of an in-memory Map because `botmux send`
 * runs as a short-lived CLI process while the card callback is handled by
 * the long-lived daemon — they are different processes with separate
 * memory spaces.
 *
 * TTL + max-count bounded so a leak doesn't grow unbounded across a
 * long-running daemon.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_FILES = 2000;

// Use os.tmpdir() so botmux send (short-lived CLI) and the daemon
// (long-lived pm2 process) share the same cache — an in-memory Map
// would be per-process and invisible to the other side.
function cacheDir(): string {
  const dir = join(tmpdir(), 'botmux-reply-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Store reply content and return a lookup key for card buttons. */
export function storeReplyContent(content: string): string {
  const dir = cacheDir();

  // Lazy eviction: if over max, delete expired files
  let files: string[] = [];
  try { files = readdirSync(dir); } catch { /* ignore */ }
  if (files.length >= MAX_FILES) {
    const now = Date.now();
    for (const f of files) {
      if (f === '.' || f === '..') continue;
      try {
        const st = statSync(join(dir, f));
        if (now - st.mtimeMs > TTL_MS) unlinkSync(join(dir, f));
      } catch { /* ignore */ }
    }
  }

  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(join(dir, `${key}.txt`), content, 'utf-8');
  return key;
}

/** Retrieve cached reply content. Returns undefined if expired or missing. */
export function getReplyContent(key: string): string | undefined {
  // Basic sanitisation: disallow path traversal
  if (key.includes('/') || key.includes('\\') || key.includes('..')) return undefined;
  const filePath = join(cacheDir(), `${key}.txt`);
  try {
    const st = statSync(filePath);
    if (Date.now() - st.mtimeMs > TTL_MS) {
      try { unlinkSync(filePath); } catch { /* ignore */ }
      return undefined;
    }
    return readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Derive a human-readable doc title from markdown: first non-empty,
 *  non-code-fence line, truncated to 50 chars. */
export function deriveTitleFromMarkdown(md: string): string {
  const lines = md.split('\n');
  let inFence = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // Skip headings markers, blockquotes, list markers for the title
    const cleaned = trimmed.replace(/^[#>*-]+ /, '').trim();
    if (cleaned) return cleaned.length > 50 ? cleaned.slice(0, 47) + '...' : cleaned;
  }
  return 'AI 回复';
}
