/**
 * Resumable-session discovery — scan a CLI's on-disk transcript store and
 * surface the sessions a user can *resume* (paseo-style import), independent of
 * whether the original CLI is still running in tmux. This powers the second
 * filter of `/adopt`: pick a stored session → botmux spawns a fresh worker that
 * runs `<cli> --resume <id>` in the recorded cwd.
 *
 * Three storage shapes are covered (one parser each, shared across CLIs):
 *   - Claude-family JSONL  (`claude-code`, `seed`, `relay`, `genius`): <dataDir>/projects/<hash>/<id>.jsonl
 *   - Codex/TRAE rollout   (`codex`, `traex`):       <sessionsRoot>/YYYY/MM/DD/rollout-*.jsonl
 *   - Antigravity history  (`antigravity`):          <home>/history.jsonl (flat submit log)
 *
 * All scans are daemon-side, pure filesystem (no PTY / subprocess), and run
 * only on an explicit `/adopt`: take the most-recent files by mtime, stream
 * metadata records line by line, and use a bounded tail window for Claude
 * `/rename` records. Parsers stop early once metadata is in hand where possible.
 */
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import type { ResumableSession } from '../adapters/cli/types.js';

const TITLE_MAX = 80;

/** Forward/head cap for transcript metadata; Claude custom titles use the
 *  separate bounded tail read below. Antigravity has its own higher cap. */
const MAX_HEAD_LINES_PER_FILE = 5_000;
/** Maximum bytes inspected from the end for the latest valid customTitle. */
const CLAUDE_CUSTOM_TITLE_TAIL_BYTES = 4 * 1024 * 1024;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Stream a JSONL file line by line, invoking `onLine` for each parsed object.
 *  Return `true` from `onLine` to stop early (closes the stream). Reading
 *  COMPLETE lines — rather than a fixed byte prefix — is deliberate: a single
 *  oversized first record (e.g. a 200KiB user prompt) must still be parsed
 *  whole to recover its `cwd`, and an append-only log's freshest entries live
 *  at the tail. Swallows fs/parse errors (missing file, corrupt line) so a bad
 *  transcript degrades to "skipped", never throws. */
async function forEachJsonLine(
  path: string,
  onLine: (rec: Record<string, unknown>) => boolean | void,
  maxLines = MAX_HEAD_LINES_PER_FILE,
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  // A missing/unreadable file emits 'error' asynchronously; without a listener
  // that becomes an unhandled error. Absorb it — the for-await below also
  // rejects and is caught, but the listener guarantees no stray crash.
  stream.on('error', () => { /* handled via try/catch */ });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const raw of rl) {
      const rec = parseJsonRecord(raw);
      if (rec && onLine(rec) === true) break;
      if (++n >= maxLines) break;
    }
  } catch {
    // missing file / read error — return what we have
  } finally {
    rl.close();
    stream.destroy();
  }
}

function truncateTitle(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  if (!norm) return '';
  return norm.length > TITLE_MAX ? `${norm.slice(0, TITLE_MAX - 1)}…` : norm;
}

/** botmux injects identifiable wrappers into every message it forwards to the
 *  CLI: the per-message `<sender type=…>` footer + `<user_message>…</user_message>`
 *  envelope, the `<botmux_routing>` block, the legacy `用户发送了：` prefix, or a
 *  `[来自 … 的 @mention]` bot handoff. A session whose user turn carries any of
 *  these was spawned BY botmux.
 *
 *  Per the `/adopt` resume design (option B), such sessions are hidden from the
 *  picker — botmux's own sessions are already resumable through their topic or
 *  session-closed card, so re-importing them is redundant and confusing. The
 *  picker exists to import GENUINELY EXTERNAL sessions (a CLI the user ran
 *  standalone in a terminal), whose first prompt is raw text with none of these
 *  markers. The session store can't be used for this — it doesn't retain closed
 *  sessions — but the transcript wrapper is a reliable, retention-independent
 *  signal. */
//  Each pattern matches a STRUCTURAL shape botmux produces — never a bare tag
//  name — so an external session whose prompt merely *discusses* botmux's XML
//  (common in this repo: "explain <botmux_routing>", "why does <sender type=
//  appear") is NOT mis-flagged.
const BOTMUX_INJECTION_PATTERNS: readonly RegExp[] = [
  // The whole prompt IS a botmux envelope. Older prompts START with the opening
  // wrapper; newer non-injecting CLIs place stable routing/identity/session
  // blocks first, then the wrapper. External prompts may discuss these tags
  // mid-text, but they don't start with this structural envelope.
  /^<user_message>[\s\S]*?<\/user_message>/,
  // The optional <whiteboard> block sits between <botmux_reminder> and
  // <user_message> (new-topic prompts place it before <user_message> too), so
  // each reminder-bearing envelope makes it optional there to stay structural —
  // a botmux-generated prompt with <whiteboard> must still drop, not get adopted.
  /^<botmux_routing>[\s\S]*?<\/botmux_routing>\s*(?:<identity>[\s\S]*?<\/identity>\s*)?<session_id>[^<]+<\/session_id>\s*(?:<role\b[\s\S]*?<\/role>\s*)?(?:<botmux_reminder>[\s\S]*?<\/botmux_reminder>\s*)?(?:<whiteboard\b[\s\S]*?<\/whiteboard>\s*)?<user_message>[\s\S]*?<\/user_message>/,
  /^<role\s+context="(?:team|group)"\s+chat_id="[^"]+">[\s\S]*?<\/role>\s*(?:<session_id>[^<]+<\/session_id>\s*)?(?:<botmux_reminder>[\s\S]*?<\/botmux_reminder>\s*)?(?:<whiteboard\b[\s\S]*?<\/whiteboard>\s*)?<user_message>[\s\S]*?<\/user_message>/,
  /^<session_id>[^<]+<\/session_id>\s*(?:<role\b[\s\S]*?<\/role>\s*)?(?:<botmux_reminder>[\s\S]*?<\/botmux_reminder>\s*)?(?:<whiteboard\b[\s\S]*?<\/whiteboard>\s*)?<user_message>[\s\S]*?<\/user_message>/,
  /^<botmux_reminder>[\s\S]*?<\/botmux_reminder>\s*(?:<whiteboard\b[\s\S]*?<\/whiteboard>\s*)?<user_message>[\s\S]*?<\/user_message>/,
  // Claude-family CLIs (injectsSessionContext=true) get routing/identity/
  // session_id via system prompt, so those blocks are NOT in the user turn —
  // when no team/group role is configured either, the prompt STARTS with the
  // <whiteboard> context block directly. None of the patterns above match a
  // `^<whiteboard>` opening (they only allow <whiteboard> as a middle element
  // after routing/role/session_id/reminder), so such botmux-origin Claude
  // sessions leaked into the /adopt picker as if external. The trailing
  // <user_message> envelope adjacency is structural — an external session
  // discussing whiteboards never starts with this shape. id matches any value
  // (not just the default `wb_` prefix) so a user-created board bound to a
  // Claude-family + role-less session (`create --id <custom>`) is also dropped,
  // consistent with the three `<whiteboard\b` patterns above.
  /^<whiteboard\s+id="[^"]+"\s*>[\s\S]*?<\/whiteboard>\s*<user_message>[\s\S]*?<\/user_message>/,
  /^用户发送了：\s*\n-{3,}/,
  // Modern envelope: the `</user_message>` close butted up against one of
  // botmux's trailing blocks (claude → <sender>, codex/traex → <session_id>,
  // plus <mentions>/<botmux_reminder>/<botmux_routing>/<available_bots>). A
  // prompt that only mentions "<user_message>" never has this adjacency.
  /<\/user_message>\s*<(?:sender|session_id|mentions|botmux_reminder|botmux_routing|available_bots)\b/i,
  // The per-message footer with a real Lark open_id — bulletproof against a
  // prompt that merely contains the substring "<sender type=".
  /<sender\s+type="(?:user|bot)"\s+open_id="ou_[0-9a-z]{16,}"/i,
  // botmux bot-handoff / quoted-message markers (e.g. antigravity `display`).
  /\[来自[^\]]*?@mention\]|\[用户引用了消息\s*用\s*botmux\s+quoted/,
  // Legacy "用户发送了：---…---" envelope PAIRED with the injected "Session ID:
  // <uuid>" — the combination (not either alone, not anchored at ^) is what's
  // unfakeable, so an optional "你已连接到飞书话题，" preamble doesn't defeat it.
  /用户发送了：\s*\n-{3,}[\s\S]*?\n-{3,}[\s\S]*?Session ID:\s*[0-9a-f]{8}-[0-9a-f]{4}-/i,
];

/** True when `text` is a botmux-generated user turn (structural envelope).
 *  Shared by Claude/Codex/Grok adopt discovery so filters stay consistent. */
export function isBotmuxInjectedPrompt(text: string): boolean {
  return BOTMUX_INJECTION_PATTERNS.some((re) => re.test(text));
}

function isBotmuxInjected(text: string): boolean {
  return isBotmuxInjectedPrompt(text);
}

interface FileEntry { path: string; mtimeMs: number; }

/** Recursively collect `*.jsonl` files under `root`, returning the most-recently
 *  modified `limit` of them. Bounded depth so a pathological tree can't wedge
 *  the scan. `excludeBasenames` drops files whose name (sans `.jsonl`) is in the
 *  set BEFORE the limit slice — used by claude-family, where the filename IS the
 *  session id, so live sessions are skipped without ever being parsed. */
async function collectRecentJsonl(
  root: string,
  limit: number,
  maxDepth = 4,
  excludeBasenames?: ReadonlySet<string>,
): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(dirents.map(async (d) => {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full, depth + 1);
      } else if (d.isFile() && d.name.endsWith('.jsonl')) {
        if (excludeBasenames?.has(d.name.slice(0, -'.jsonl'.length))) return;
        try {
          const st = await fs.stat(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }));
  }
  await walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// ─── Claude-family JSONL (claude-code, seed, relay, genius) ──────────────────

/** Scan a bounded tail for the latest valid customTitle. Skip the first line
 *  only when the byte boundary cuts through it. */
async function findLatestClaudeCustomTitle(path: string): Promise<string> {
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return '';
  }
  if (stat.size <= 0) return '';

  const start = Math.max(0, stat.size - CLAUDE_CUSTOM_TITLE_TAIL_BYTES);
  let skipFirstLine = false;
  if (start > 0) {
    let handle;
    try {
      handle = await fs.open(path, 'r');
      const previous = Buffer.alloc(1);
      const { bytesRead } = await handle.read(previous, 0, 1, start - 1);
      // If the tail starts immediately after a newline, its first line is
      // complete. Otherwise it is the residual of a line cut by the byte cap.
      skipFirstLine = bytesRead !== 1 || previous[0] !== 0x0a;
    } catch {
      // Prefer dropping a possibly partial first line if the probe races with
      // a rotated/unreadable transcript.
      skipFirstLine = true;
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  const stream = createReadStream(path, {
    encoding: 'utf8',
    start,
    end: stat.size - 1,
  });
  stream.on('error', () => { /* handled via try/catch */ });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let latest = '';
  let first = true;
  try {
    for await (const raw of rl) {
      if (first && skipFirstLine) {
        first = false;
        continue;
      }
      first = false;
      const rec = parseJsonRecord(raw);
      if (!rec || rec.isSidechain === true || typeof rec.customTitle !== 'string') continue;
      const title = truncateTitle(rec.customTitle);
      if (title) latest = title;
    }
  } catch {
    // Missing, unreadable, or concurrently rotated transcripts return what we have.
  } finally {
    rl.close();
    stream.destroy();
  }
  return latest;
}

/** Parse one Claude JSONL transcript. The session id is the filename; cwd,
 *  first user prompt, and the latest valid customTitle come from the content.
 *  Sidechain / synthetic / slash-command entries are skipped. The head pass
 *  finds the identity/origin metadata, then a bounded tail pass finds the
 *  latest valid custom title. A custom title wins when present; otherwise the
 *  user's real first turn is the fallback. */
async function parseClaudeTranscript(path: string, mtimeMs: number): Promise<ResumableSession | null> {
  const cliSessionId = basename(path, '.jsonl');
  if (!cliSessionId) return null;
  // Accumulate into an object (see parseRolloutTranscript) so the post-loop
  // guard narrows correctly despite closure mutation.
  const acc: { cwd: string | null; fallbackTitle: string; botmux: boolean } = {
    cwd: null,
    fallbackTitle: '',
    botmux: false,
  };
  await forEachJsonLine(path, (rec) => {
    if (rec.isSidechain === true) return;
    if (!acc.cwd && typeof rec.cwd === 'string') acc.cwd = rec.cwd;
    // Origin and fallback title are both determined by the first meaningful
    // user turn. Do not reclassify an external session if it is later resumed
    // through botmux while we continue scanning for a rename.
    if (!acc.fallbackTitle && rec.type === 'user') {
      const raw = rawClaudeUserText(rec.message);
      if (raw && isBotmuxInjected(raw)) { acc.botmux = true; return true; } // botmux-origin → drop
      if (raw) {
        const clean = cleanUserPromptForTitle(raw);
        if (clean) acc.fallbackTitle = truncateTitle(clean);
      }
    }
    return Boolean(acc.cwd && acc.fallbackTitle);
  });
  // Drop botmux-origin sessions and empties (no real user prompt → command-only
  // / aborted — not worth importing).
  if (acc.botmux || !acc.cwd || !acc.fallbackTitle) return null;
  const tailTitle = await findLatestClaudeCustomTitle(path);
  return {
    cliSessionId,
    cwd: acc.cwd,
    title: tailTitle || acc.fallbackTitle,
    lastActivityAt: mtimeMs,
  };
}

/** Pull plain user text out of a Claude `message` field (string content or the
 *  first text part of array content), trimmed. Returns null for tool-result /
 *  non-text messages. No filtering — used both for botmux-origin detection
 *  (which must see the raw wrapper) and as the source for the title. */
function rawClaudeUserText(message: unknown): string | null {
  const msg = asRecord(message);
  if (!msg || msg.role !== 'user') return null;
  let text: string | null = null;
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    const part = msg.content.find((p) => asRecord(p)?.type === 'text');
    const t = asRecord(part)?.text;
    if (typeof t === 'string') text = t;
  }
  const trimmed = text?.trim();
  return trimmed || null;
}

/** Reject slash-command / local-command meta turns (not a meaningful title);
 *  returns the text otherwise. */
function cleanUserPromptForTitle(raw: string): string | null {
  if (raw.startsWith('<command-') || raw.startsWith('<local-command')) return null;
  return raw;
}

export async function discoverClaudeFamilySessions(
  dataDir: string,
  limit: number,
  exclude?: ReadonlySet<string>,
): Promise<ResumableSession[]> {
  const projectsRoot = join(dataDir, 'projects');
  // The jsonl filename IS the session id, so excluded (live) sessions are
  // dropped here — before any file is parsed — and never count against `limit`.
  const files = await collectRecentJsonl(projectsRoot, limit * 3, 2, exclude);
  const parsed = await Promise.all(files.map((f) => parseClaudeTranscript(f.path, f.mtimeMs)));
  return parsed.filter((s): s is ResumableSession => s !== null).slice(0, limit);
}

// ─── Codex / TRAE rollout (codex, traex) ─────────────────────────────────────

/** Codex >=0.147 rollouts no longer emit `event_msg`/`user_message`; user turns
 *  then live in `response_item` message role:user entries. The FIRST of those is
 *  a synthetic startup preamble, never a real prompt. Observed shapes (verified
 *  against ~80 live ~/.codex rollouts): the `<environment_context>` block, the
 *  `<recommended_plugins>` list, the legacy `<permissions>` block, and codex's
 *  `# AGENTS.md instructions for …` injection (which may share the message with
 *  `<environment_context>` via multiple input_text blocks). */
const SYNTHETIC_PREAMBLE_PATTERNS: readonly RegExp[] = [
  // 锚定行首：合成 preamble 总是独立条目或以 tag 开头；不锚定会误杀散文中
  // 提及这些标签的真实 prompt（如「<environment_context> 是什么意思」）。
  /^<environment_context\b/,
  /^<recommended_plugins\b/,
  /^<permissions\b/,
];

function isSyntheticPreamble(text: string): boolean {
  if (SYNTHETIC_PREAMBLE_PATTERNS.some((re) => re.test(text))) return true;
  return /^# AGENTS\.md instructions\b/.test(text);
}

/** Join all `input_text` blocks of a rollout `response_item` message payload —
 *  content is an array of `{type, text}` and a single user turn may span several
 *  blocks (e.g. AGENTS.md instructions + environment_context). Mirrors
 *  joinTextBlocks in codex-transcript; kept local so this discovery service has
 *  no cross-service dependency. Trimmed so the ^-anchored botmux/synthetic
 *  checks below see the real start of the prompt. */
function rolloutResponseItemText(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.type === 'input_text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.join('').trim();
}

/** Parse one Codex/TRAE rollout. `session_meta` carries the resume id + cwd.
 *  Title preference: the first `event_msg`/`user_message` (legacy format); when
 *  absent (Codex >=0.147), the first non-synthetic `response_item` role:user
 *  message — skipping the startup preamble and botmux-injected turns (which mark
 *  the whole session botmux-origin, same as the user_message path). Streamed
 *  line by line, stopping once id + cwd + title are found. */
async function parseRolloutTranscript(
  path: string,
  mtimeMs: number,
  exclude?: ReadonlySet<string>,
): Promise<ResumableSession | null> {
  // Accumulate into an object — closure mutation of plain `let` defeats TS's
  // control-flow narrowing at the post-loop guard; object properties keep their
  // declared type.
  const acc: { id: string | null; cwd: string | null; title: string; fallbackTitle: string; botmux: boolean } = {
    id: null, cwd: null, title: '', fallbackTitle: '', botmux: false,
  };
  let excluded = false;
  await forEachJsonLine(path, (rec) => {
    const payload = asRecord(rec.payload);
    if (rec.type === 'session_meta' && payload) {
      if (typeof payload.id === 'string') {
        acc.id = payload.id;
        // The resume id lives on the very first line; bail immediately on a
        // live session so excluded rollouts cost a single line read.
        if (exclude?.has(payload.id)) { excluded = true; return true; }
      }
      if (typeof payload.cwd === 'string') acc.cwd = payload.cwd;
    } else if (rec.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
      if (isBotmuxInjected(payload.message)) { acc.botmux = true; return true; } // botmux-origin → drop
      if (!acc.title) acc.title = truncateTitle(payload.message);
    } else if (rec.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
      // New-format (>=0.147) fallback title source. The first meaningful user
      // turn determines origin, mirroring parseClaudeTranscript: a synthetic
      // preamble is skipped, a botmux-wrapped turn drops the session, and the
      // first raw turn becomes the fallback title (a later event_msg/user_message
      // still wins when the rollout carries both).
      const text = rolloutResponseItemText(payload);
      if (!text) return; // empty / non-text content — not a title candidate
      if (isSyntheticPreamble(text)) return; // startup preamble, not a user turn
      if (isBotmuxInjected(text)) { acc.botmux = true; return true; } // botmux-origin → drop
      if (!acc.fallbackTitle) acc.fallbackTitle = truncateTitle(text);
      // 新格式（>=0.147）rollout 没有 event_msg/user_message，acc.title 永远
      // 为空：不含 fallbackTitle 会扫满 MAX_HEAD_LINES_PER_FILE。首个真实用户
      // 回合即定 origin（与 legacy 路径「id+cwd+title 齐即停扫」一致）；混合
      // 格式文件中 legacy 条目按时间序在前，acc.title 会先命中早退，不受影响。
      if (acc.id && acc.cwd && acc.fallbackTitle) return true;
    }
    return Boolean(acc.id && acc.cwd && acc.title);
  });
  const title = acc.title || acc.fallbackTitle;
  if (excluded || acc.botmux || !acc.id || !acc.cwd || !title) return null;
  return { cliSessionId: acc.id, cwd: acc.cwd, title, lastActivityAt: mtimeMs };
}

export async function discoverRolloutSessions(
  sessionsRoot: string,
  limit: number,
  exclude?: ReadonlySet<string>,
): Promise<ResumableSession[]> {
  // The resume id is inside the file (not the filename), so we can't pre-filter
  // by name. Instead walk most-recent-first and parse until `limit` non-excluded
  // sessions are collected — excluded ones cost only a first-line read, so a
  // host with many live sessions doesn't starve the picker.
  const files = await collectRecentJsonl(sessionsRoot, Number.MAX_SAFE_INTEGER, 5);
  const out: ResumableSession[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    const s = await parseRolloutTranscript(f.path, f.mtimeMs, exclude);
    if (s) out.push(s);
  }
  return out;
}

// ─── Antigravity flat history log (antigravity) ──────────────────────────────

/** Antigravity appends one line per submit: `{display, timestamp, workspace,
 *  conversationId}`. This is an append-only log — the freshest conversations
 *  live at the TAIL — so we stream the WHOLE file (a flat submit log, not a
 *  per-session transcript, so it stays small) rather than a bounded prefix that
 *  would hide recent sessions once the file grows. Dedup by conversationId,
 *  keeping the latest timestamp; the first display seen for a conversation is
 *  its title. */
export async function discoverAntigravitySessions(
  historyPath: string,
  limit: number,
  exclude?: ReadonlySet<string>,
): Promise<ResumableSession[]> {
  const byConversation = new Map<string, ResumableSession>();
  const botmuxConversations = new Set<string>(); // conversations with any botmux-injected submit
  // Read the full log (high line cap, no byte prefix) so tail entries are seen.
  await forEachJsonLine(historyPath, (rec) => {
    const conversationId = rec.conversationId;
    const workspace = rec.workspace;
    if (typeof conversationId !== 'string' || !conversationId || typeof workspace !== 'string' || !workspace) return;
    const ts = typeof rec.timestamp === 'number' ? rec.timestamp : 0;
    const display = typeof rec.display === 'string' ? rec.display : '';
    // A botmux-injected submit marks the whole conversation as botmux-origin.
    if (isBotmuxInjected(display)) { botmuxConversations.add(conversationId); return; }
    const existing = byConversation.get(conversationId);
    if (!existing) {
      if (!display.trim()) return; // empty/no-prompt submit — skip
      byConversation.set(conversationId, {
        cliSessionId: conversationId,
        cwd: workspace,
        title: truncateTitle(display),
        lastActivityAt: ts,
      });
    } else if (ts > existing.lastActivityAt) {
      existing.lastActivityAt = ts;
    }
  }, 1_000_000);
  return [...byConversation.values()]
    .filter((s) => !exclude?.has(s.cliSessionId) && !botmuxConversations.has(s.cliSessionId))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}
