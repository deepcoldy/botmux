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
 * title records (`/rename` customTitle, auto-generated aiTitle). Parsers stop
 * early once metadata is in hand where possible.
 */
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import type { ResumableSession } from '../adapters/cli/types.js';
import { isInternalCodexSessionMeta } from './codex-session-meta.js';
import { isBotmuxGoalObjective } from '../workflows/v3/contract.js';

const TITLE_MAX = 80;

/** Forward/head cap for transcript metadata; Claude custom / AI titles use the
 *  separate bounded tail read below. Antigravity has its own higher cap. */
const MAX_HEAD_LINES_PER_FILE = 5_000;
/** Maximum bytes inspected from the end for the latest valid customTitle / aiTitle. */
const CLAUDE_TITLE_TAIL_BYTES = 4 * 1024 * 1024;

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

/** Leading blocks botmux may place BEFORE `<user_message>`. Order-independent by
 *  construction: {@link startsWithBotmuxLeadingBlock} walks whichever of these
 *  the prompt opens with, so a new block needs one entry here rather than a new
 *  ordering permutation in BOTMUX_INJECTION_PATTERNS. */
const BOTMUX_LEADING_BLOCK_TAGS: readonly string[] = [
  'botmux_routing', 'botmux_builtin_skills', 'identity', 'session_id', 'role',
  'summary_memory', 'botmux_reminder', 'whiteboard', 'chat_context_policy', 'chat_context',
];

/** True when `text` is an UNBROKEN CHAIN of botmux leading blocks followed by a
 *  complete `<user_message>…</user_message>` envelope — only blocks and
 *  whitespace in between, never prose.
 *
 *  Why this exists: the `^`-anchored patterns above enumerate exact block
 *  ORDERINGS, so each new leading block multiplies the permutations — and any
 *  chain nobody spelled out leaked into the /adopt picker as if external.
 *  Measured: 14 of 30 claude-family combinations leaked (every prefix
 *  containing `<summary_memory>` or `<chat_context…>`, e.g. `role+summary`,
 *  `wb+chatctx`) — those match no `^` anchor, and with a bot running
 *  `senderTag: false` and no @mentions that turn, nothing follows
 *  `</user_message>` either, so the trailing-adjacency pattern misses too.
 *
 *  ADJACENCY IS LOAD-BEARING. A first version required only "opens with a known
 *  tag AND contains an envelope somewhere later", which let arbitrary prose sit
 *  between the two — and that false-positives on a REAL external session whose
 *  own text happens to do this, e.g. a user pasting a prompt template to edit:
 *  `<summary_memory>…</summary_memory>\n\n帮我改措辞：\n<user_message>…</user_message>`.
 *  Such a session belongs in the picker; swallowing it defeats the point. The
 *  earlier `^` patterns got this right by demanding structural adjacency, so this
 *  restores it while staying order-independent. (Rejected alternative: requiring
 *  the opening `>` be followed by `\n`/`<`. Four shipped blocks put body text
 *  directly after `>` — `<chat_context_policy>群名…`, `<botmux_reminder>提醒…`,
 *  `<session_id>abc-123…`, `<role …>某人格…` — so that rule would re-open the
 *  very leak this function exists to close. Verified by rendering each block.)
 *
 *  A prompt that pastes a genuine full botmux envelope verbatim is still a false
 *  positive, but that input is byte-identical to botmux's own output, so no
 *  content-based check can separate them; accepted as residual.
 *
 *  KNOWN RESIDUAL FALSE NEGATIVE (this function cannot ADD one — see below): the
 *  close lookup takes the FIRST `</tag>`, so a block whose own body contains that
 *  literal string ends early and the walk then hits prose and bails. Reachable
 *  only through `<role>`: `renderRoleContextBlock` interpolates persona text
 *  unescaped, so a persona containing `</role>` (nested or bare) truncates the
 *  block. Measured: such prompts leak, while the same shape without the literal
 *  is correctly dropped. Deliberately NOT fixed — the two candidate fixes are
 *  both worse:
 *    - depth-counting `<role …>` vs `</role>` only handles the NESTED variant; a
 *      bare `</role>` in the body has no opening tag to count, so it still leaks;
 *    - taking the LAST `</tag>` before the envelope fixes both but introduces a
 *      real false positive — an external prompt discussing two of the same block
 *      (`<session_id>abc</session_id> 请解释 <session_id>def</session_id>` +
 *      envelope) then gets swallowed, which is the failure direction that
 *      actually costs the user something.
 *
 *  Why "cannot ADD a false negative" is structural, not just sampled:
 *  `isBotmuxInjectedPrompt` ORs this check BEFORE the pattern list, so the
 *  function is a pure disjunctive addition — it can only turn `false` into
 *  `true`, never the reverse. Any prompt the pre-existing patterns dropped is
 *  still dropped. (Spot-checked over 4,000 generated block chains: zero cases
 *  where the old verdict was `true` and the new one `false`.) The residual above
 *  is therefore inherited, not introduced: the affected shapes — role-with-literal
 *  plus `<summary_memory>` — leaked before this function existed, because
 *  `summary_memory` appears in none of the `^`-anchored orderings. Note the
 *  legacy `^<role…>` pattern is NOT itself fooled by a literal `</role>`: its
 *  lazy quantifier backtracks to the second one, so `role-with-literal` directly
 *  followed by the envelope still matches there. The two mechanisms fail on
 *  different inputs; only their intersection leaks.
 *  Failure direction is a session merely APPEARING in the /adopt list.
 *
 *  Deliberately NOT a regex. The natural regex form
 *  (`^<(?:tag|…)\b[^>]*>[\s\S]*?<user_message>[\s\S]*?<\/user_message>`) is
 *  quadratic: both lazy scans restart at every `<user_message>` occurrence, so
 *  a prompt of repeated `<user_message>` opens with no close took 374ms at 100k
 *  chars and 5969ms at 400k (4× input → 16× time), against 0.3ms for the
 *  pre-existing patterns on the same input. Every scan below is `startsWith` /
 *  `indexOf` over a strictly advancing cursor — linear, cannot backtrack. A
 *  failed `indexOf` returns immediately, so at most one full-length scan happens
 *  per call: a 50k-block chain measured 20.7ms, a 1.5MB adversarial input ~3ms. */
function startsWithBotmuxLeadingBlock(text: string): boolean {
  if (!text.startsWith('<')) return false;
  let i = 0;
  let sawBlock = false;
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++;
    if (text.startsWith('<user_message>', i)) {
      // Require at least one preceding block: a bare `^<user_message>` prompt is
      // already covered by the first pattern above.
      return sawBlock && text.indexOf('</user_message>', i + '<user_message>'.length) !== -1;
    }
    if (text[i] !== '<') return false;
    // Tag name ends at the first whitespace or '>' after the opening '<'.
    let nameEnd = -1;
    for (let j = i + 1; j < text.length; j++) {
      const ch = text[j]!;
      if (ch === '>' || ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { nameEnd = j; break; }
    }
    if (nameEnd < i + 2) return false;
    const tag = text.slice(i + 1, nameEnd);
    if (!BOTMUX_LEADING_BLOCK_TAGS.includes(tag)) return false;
    // An unclosed block is not a structural block — bail rather than scan on.
    const close = text.indexOf(`</${tag}>`, nameEnd);
    if (close === -1) return false;
    i = close + tag.length + 3;
    sawBlock = true;
  }
}

/** True when `text` is a botmux-generated user turn (structural envelope).
 *  Shared by Claude/Codex/Grok adopt discovery so filters stay consistent. */
export function isBotmuxInjectedPrompt(text: string): boolean {
  if (startsWithBotmuxLeadingBlock(text)) return true;
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

/** Scan a bounded tail for the latest valid customTitle (`/rename`) and the
 *  latest valid aiTitle (Claude's auto-generated title; only `type: "ai-title"`
 *  records count). Claude re-appends both with its session metadata near the
 *  end of the transcript, so a running session in the middle of a single
 *  turn larger than the window may briefly miss them and fall back to the
 *  first prompt. Skip the first line only when the byte boundary cuts
 *  through it. */
async function findLatestClaudeTitles(path: string): Promise<{ customTitle: string; aiTitle: string }> {
  const latest = { customTitle: '', aiTitle: '' };
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    return latest;
  }
  if (stat.size <= 0) return latest;

  const start = Math.max(0, stat.size - CLAUDE_TITLE_TAIL_BYTES);
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
  let first = true;
  try {
    for await (const raw of rl) {
      if (first && skipFirstLine) {
        first = false;
        continue;
      }
      first = false;
      const rec = parseJsonRecord(raw);
      if (!rec || rec.isSidechain === true) continue;
      if (typeof rec.customTitle === 'string') {
        const title = truncateTitle(rec.customTitle);
        if (title) latest.customTitle = title;
      }
      if (rec.type === 'ai-title' && typeof rec.aiTitle === 'string') {
        const title = truncateTitle(rec.aiTitle);
        if (title) latest.aiTitle = title;
      }
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
 *  first user prompt, and the latest valid customTitle / aiTitle come from the
 *  content. Sidechain / synthetic / slash-command entries are skipped, and
 *  isMeta turns (Claude-written, e.g. a skill body expansion) never become the
 *  first prompt. The head pass finds the identity/origin metadata, then a
 *  bounded tail pass finds the latest valid custom and AI titles. Title
 *  priority: customTitle > aiTitle > the user's real first turn; a session
 *  with none of the three is dropped. */
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
      // isMeta turns are written by Claude itself (skill body expansion,
      // local-command caveat, hook output), not typed by the user: they still
      // go through the origin check above, but never become the title.
      if (raw && rec.isMeta !== true) {
        const clean = cleanUserPromptForTitle(raw);
        if (clean) acc.fallbackTitle = truncateTitle(clean);
      }
    }
    return Boolean(acc.cwd && acc.fallbackTitle);
  });
  // Drop botmux-origin sessions and those without a cwd before reading the tail.
  if (acc.botmux || !acc.cwd) return null;
  const tail = await findLatestClaudeTitles(path);
  const title = tail.customTitle || tail.aiTitle || acc.fallbackTitle;
  // No native title and no real user prompt → command-only / aborted — not
  // worth importing.
  if (!title) return null;
  return {
    cliSessionId,
    cwd: acc.cwd,
    title,
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

/** Raw model-visible user items of one TraeX `history_mutation` (append or
 *  compaction `replace`). WEAK source only: TraeX also writes runtime
 *  injections (context reminders, warnings) here as `role: user`, so these
 *  never decide origin on their own — see parseRolloutTranscript. */
function rolloutHistoryMutationUserTexts(payload: Record<string, unknown>): string[] {
  if ((payload.operation !== 'append' && payload.operation !== 'replace')
    || !Array.isArray(payload.items)) return [];
  const texts: string[] = [];
  for (const item of payload.items) {
    const message = asRecord(item);
    if (message?.type !== 'message' || message.role !== 'user') continue;
    const text = rolloutResponseItemText(message);
    if (text) texts.push(text);
  }
  return texts;
}

/** TraeX ≥0.208 opens every conversation with a user-role item that is one
 *  whole `<system-reminder>…</system-reminder>` block carrying its own context
 *  (gitStatus / currentDate), ahead of the real prompt. Not a user turn. */
function isTraexContextReminder(text: string): boolean {
  return /^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text);
}

export interface RolloutSessionMetadata {
  /** Display title only — never decides origin. */
  title?: string;
  /** The thread's ORIGINAL first input from the native index (TraeX:
   *  `threads.preview`). Decides origin and the inferred title outright, like a
   *  canonical record seen before any other; absent → the rollout decides. */
  firstUserMessage?: string;
  /** The native index already proved botmux spawned this session. */
  botmuxOrigin?: boolean;
  cwd?: string;
  lastActivityAt?: number;
  /** Rollout the native index points at (TraeX: the current resume segment). */
  rolloutPath?: string;
}

export interface RolloutDiscoveryOptions {
  /** `traex` enables the TraeX rules below; the default is Codex's parser. */
  dialect?: 'codex' | 'traex';
  /** Native index metadata keyed by session id. TraeX's state DB title wins
   *  over a title inferred from the first prompt, preserving /rename — but only
   *  for a session that has a real, non-botmux first prompt: the native title
   *  decorates an origin-checked session, it never admits one on its own. */
  metadataById?: ReadonlyMap<string, RolloutSessionMetadata>;
  /** TraeX: batch-load the prompt-derived metadata (title / first prompt /
   *  origin) for these ids, merged over `metadataById`. Called only for the
   *  threads discovery is about to parse, so the per-/adopt cost no longer
   *  scales with every prompt in the store. */
  loadSessionDetails?: (ids: readonly string[]) => ReadonlyMap<string, RolloutSessionMetadata>;
  /** Verified user input carried by one record (TraeX: validated
   *  `display_completions[].UserMessage` and the 0.201.4 item_completed
   *  mirror). These decide origin; raw model `items` are only a weak fallback. */
  userInputTexts?: (rec: Record<string, unknown>, sourceSessionId: string | undefined) => string[];
  /** Stable thread id from a rollout filename. TraeX resume segments share it,
   *  which lets discovery order threads by native activity and skip sibling
   *  segments without reading them. */
  sessionIdFromPath?: (path: string) => string | undefined;
}

/** `session`: a candidate. `rejected`: this thread id is out for good
 *  (botmux-origin, internal helper, live/excluded) — sibling segments of the
 *  same thread must not resurrect it. `skip`: inconclusive (unreadable, no
 *  session_meta, no real user turn); another segment may still qualify. */
type RolloutParse =
  | { kind: 'session'; session: ResumableSession }
  | { kind: 'rejected'; cliSessionId: string }
  | { kind: 'skip' };

/** Parse one Codex/TRAE rollout. session_meta carries the resume id + cwd.
 *  Codex: the first event_msg/user_message, else the first non-synthetic
 *  response_item role:user, decides origin and title.
 *  TraeX: internal helper sessions (guardian/subagent) are rejected up front,
 *  a native index first prompt decides outright, botmux v3's own `/goal`
 *  objective counts as botmux-origin, and everything else follows the
 *  first-turn rule below.
 *
 *  ── TraeX first-turn rule (one state machine; keep this table and the
 *     table-driven test "TraeX first-turn rule" in sync) ──────────────────
 *  Records, each with an optional native turn id:
 *    W  weak user item   response_item role:user, raw history_mutation item
 *                        (TraeX also writes runtime injections there)
 *    C  canonical input  verified display completion / item_completed
 *                        (options.userInputTexts), event_msg user_message
 *    T  terminal         event_msg task_complete / turn_aborted
 *  Synthetic preambles / context reminders never count as W or C.
 *  "Same turn" for ids a, b: a === b when both are known; true when either is
 *  unknown (legacy turn-less shapes — the T rule below keeps them inside the
 *  first turn).
 *
 *    phase  record  effect
 *    open   W       the first one fixes the WEAK verdict (its text: title, or
 *                   botmux) and the first turn's id (may be unknown) → weak
 *    open   C       decides origin outright (botmux → reject; clean → title)
 *    open   T       ignored — there is no verdict to close
 *    weak   W / C   LATE BINDING: same text as the verdict, carrying a turn id
 *                   while the first turn's id is unknown → that id becomes the
 *                   first turn's (a mirror of the same input revealed it)
 *    weak   W       otherwise ignored: the first weak item already decided
 *    weak   C       same turn as the first turn → overrides the weak verdict
 *                   (botmux → reject; clean → title); a different, known turn
 *                   (steer / type-ahead of the next turn) → ignored
 *    weak   T       same turn → the first turn is over: the weak verdict is
 *                   final and scanning stops; a different, known turn (a
 *                   replayed terminal in a resumed rollout) → ignored
 *  End of scan in phase weak: a botmux weak verdict rejects the thread; a
 *  clean one titles it. */
async function parseRolloutTranscript(
  path: string,
  mtimeMs: number,
  exclude?: ReadonlySet<string>,
  options: RolloutDiscoveryOptions = {},
  lookupMetadata: (id: string) => RolloutSessionMetadata | undefined = id => options.metadataById?.get(id),
): Promise<RolloutParse> {
  const traex = options.dialect === 'traex';
  // Accumulate into an object — closure mutation of plain `let` defeats TS's
  // control-flow narrowing at the post-loop guard; object properties keep their
  // declared type.
  const acc: {
    id: string | null;
    cwd: string | null;
    title: string;
    fallbackTitle: string;
    weakTitle: string;
    botmux: boolean;
    /** TraeX: the session is out for good (internal / botmux / excluded). */
    rejected: boolean;
    /** TraeX: the first non-synthetic weak user item already fixed the weak
     *  origin/title; later weak items must not re-decide it. */
    weakDecided: boolean;
    /** TraeX: that first weak item was botmux. Rejects the thread at the end
     *  of the first turn unless a canonical record in it says otherwise. */
    weakBotmux: boolean;
    /** TraeX: native turn id of that first weak item, when it carries one.
     *  Only canonical records of this same turn may override the weak verdict:
     *  steer / type-ahead input of the NEXT turn can land before this turn's
     *  terminal record. */
    weakTurnId: string | undefined;
    /** TraeX: text of that first weak item, to recognise its mirrors. */
    weakText: string;
  } = {
    id: null, cwd: null, title: '', fallbackTitle: '', weakTitle: '', botmux: false,
    rejected: false, weakDecided: false, weakBotmux: false, weakTurnId: undefined, weakText: '',
  };
  let excluded = false;
  let nativeMetadata: RolloutSessionMetadata | undefined;
  const pathSessionId = options.sessionIdFromPath?.(path);
  // TraeX also runs botmux v3 goal workers, whose first input is botmux's own
  // `/goal` objective rather than a Lark envelope.
  const isBotmuxTurn = (text: string): boolean =>
    isBotmuxInjected(text) || (traex && isBotmuxGoalObjective(text));
  const recordCanonicalUserText = (text: string): boolean | undefined => {
    if (!text || isSyntheticPreamble(text) || isTraexContextReminder(text)) return;
    if (isBotmuxTurn(text)) {
      acc.botmux = true;
      return true;
    }
    if (!acc.fallbackTitle) acc.fallbackTitle = truncateTitle(text);
    return Boolean(acc.id && acc.cwd && acc.fallbackTitle);
  };
  const isUserTurnText = (text: string): boolean =>
    Boolean(text) && !isSyntheticPreamble(text) && !isTraexContextReminder(text);
  // First-turn rule (see the table above). Weak verdict = phase "weak".
  const inFirstTurn = (turnId: string | undefined): boolean =>
    !acc.weakDecided || acc.weakTurnId === undefined || turnId === undefined || turnId === acc.weakTurnId;
  const bindFirstTurnMirror = (text: string, turnId: string | undefined): void => {
    if (acc.weakDecided && acc.weakTurnId === undefined && turnId !== undefined && text === acc.weakText) {
      acc.weakTurnId = turnId;
    }
  };
  const recordWeakUserText = (text: string, turnId: string | undefined): void => {
    if (!isUserTurnText(text)) return;
    if (acc.weakDecided) { bindFirstTurnMirror(text, turnId); return; }
    acc.weakDecided = true;
    acc.weakTurnId = turnId;
    acc.weakText = text;
    // A botmux first turn leaves no weak title and marks the thread botmux
    // unless a canonical record of the same turn supplies a clean prompt.
    if (isBotmuxTurn(text)) acc.weakBotmux = true;
    else acc.weakTitle = truncateTitle(text);
  };
  /** A canonical input under the first-turn rule; true → stop scanning. */
  const recordFirstTurnCanonical = (rawText: string, turnId: string | undefined): boolean => {
    const text = rawText.trim();
    if (!isUserTurnText(text)) return false;
    bindFirstTurnMirror(text, turnId);
    if (!inFirstTurn(turnId)) return false;
    return recordCanonicalUserText(text) === true;
  };
  await forEachJsonLine(path, (rec) => {
    const payload = asRecord(rec.payload);
    const turnId = typeof payload?.turn_id === 'string' && payload.turn_id ? payload.turn_id : undefined;
    if (rec.type === 'session_meta' && payload) {
      if (typeof payload.id === 'string') {
        acc.id = payload.id;
        // The resume id lives on the very first line; bail immediately on a
        // live session so excluded rollouts cost a single line read.
        if (exclude?.has(payload.id)) { excluded = true; return true; }
        // Guardian / subagent helpers are not the user's task, whatever their
        // user records say — reject before trusting any metadata (same rule as
        // the pid lookup's rollout classification).
        if (traex && isInternalCodexSessionMeta(payload)) { acc.rejected = true; return true; }
        nativeMetadata = lookupMetadata(payload.id);
        if (nativeMetadata?.botmuxOrigin) { acc.botmux = true; return true; } // botmux-origin → drop
      }
      if (typeof payload.cwd === 'string') acc.cwd = payload.cwd;
      if (nativeMetadata?.firstUserMessage) {
        const stop = recordCanonicalUserText(nativeMetadata.firstUserMessage.trim());
        if (stop) return true;
      }
    } else if (traex && rec.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
      // TraeX canonical input (C) under the first-turn rule.
      if (recordFirstTurnCanonical(payload.message, turnId)) return true;
    } else if (rec.type === 'event_msg' && payload?.type === 'user_message' && typeof payload.message === 'string') {
      if (isBotmuxTurn(payload.message)) { acc.botmux = true; return true; } // botmux-origin → drop
      if (!acc.title) acc.title = truncateTitle(payload.message);
    } else if (traex) {
      if (rec.type === 'event_msg' && payload?.type === 'thread_goal_updated') {
        const objective = asRecord(payload.goal)?.objective;
        if (typeof objective === 'string' && isBotmuxGoalObjective(objective)) {
          acc.botmux = true; // a botmux v3 goal worker → drop
          return true;
        }
      }
      for (const text of options.userInputTexts?.(rec, pathSessionId ?? acc.id ?? undefined) ?? []) {
        if (recordFirstTurnCanonical(text, turnId)) return true; // C
      }
      if (rec.type === 'history_mutation' && payload) {
        for (const text of rolloutHistoryMutationUserTexts(payload)) recordWeakUserText(text, turnId); // W
      } else if (rec.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
        recordWeakUserText(rolloutResponseItemText(payload), turnId); // W
      } else if (rec.type === 'event_msg' && acc.weakDecided && inFirstTurn(turnId)
        && (payload?.type === 'task_complete' || payload?.type === 'turn_aborted')) {
        // T of the first turn (the two terminal records the TraeX bridge
        // recognises): the weak verdict is final; don't read the rest of a
        // possibly huge rollout.
        return true;
      }
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
      if (!acc.weakTitle) acc.weakTitle = truncateTitle(text);
      // 新格式（>=0.147）rollout 没有 event_msg/user_message，acc.title 永远
      // 为空：不含 fallbackTitle 会扫满 MAX_HEAD_LINES_PER_FILE。首个真实用户
      // 回合即定 origin（与 legacy 路径「id+cwd+title 齐即停扫」一致）；混合
      // 格式文件中 legacy 条目按时间序在前，acc.title 会先命中早退，不受影响。
      if (acc.id && acc.cwd && acc.weakTitle) return true;
    }
    return Boolean(acc.id && acc.cwd && acc.title);
  });
  const weakBotmux = acc.weakBotmux && !acc.title && !acc.fallbackTitle;
  if (acc.id && (excluded || acc.botmux || acc.rejected || weakBotmux)) {
    return { kind: 'rejected', cliSessionId: acc.id };
  }
  const inferredTitle = acc.title || acc.fallbackTitle || acc.weakTitle;
  // No real user turn → nothing was origin-checked (and nothing to resume): a
  // native title alone must not admit the session.
  if (!acc.id || !acc.cwd || !inferredTitle) return { kind: 'skip' };
  return {
    kind: 'session',
    session: {
      cliSessionId: acc.id,
      cwd: nativeMetadata?.cwd || acc.cwd,
      title: truncateTitle(nativeMetadata?.title ?? inferredTitle) || inferredTitle,
      lastActivityAt: nativeMetadata?.lastActivityAt ?? mtimeMs,
    },
  };
}

/** Extra threads whose prompt metadata is prefetched beyond the ones still
 *  needed to fill `limit` (covers a few rejections without another query). */
const DETAILS_PREFETCH_MARGIN = 8;

interface RolloutCandidate extends FileEntry {
  /** Stable thread id from the filename, when the dialect can tell. */
  sessionId?: string;
}

/** TraeX: order rollout files by the activity the picker will REPORT — the
 *  native `updated_at` when the index has the thread, else the file mtime —
 *  instead of raw mtime, so `limit` keeps the most recently active threads.
 *  Within one thread (resume segments share the filename id) the segment the
 *  index points at goes first, then the newest. Pure in-memory reorder of the
 *  already-stat'ed list: no extra I/O. */
function orderTraexRolloutCandidates(
  files: FileEntry[],
  options: RolloutDiscoveryOptions,
): RolloutCandidate[] {
  const sessionIdFromPath = options.sessionIdFromPath;
  if (!sessionIdFromPath) return files;
  return files
    .map((file, index) => {
      const sessionId = sessionIdFromPath(file.path);
      const metadata = sessionId ? options.metadataById?.get(sessionId) : undefined;
      return {
        ...file,
        ...(sessionId ? { sessionId } : {}),
        activityMs: metadata?.lastActivityAt ?? file.mtimeMs,
        indexed: metadata?.rolloutPath === file.path,
        index,
      };
    })
    .sort((a, b) => b.activityMs - a.activityMs
      || Number(b.indexed) - Number(a.indexed)
      || a.index - b.index)
    .map(({ path, mtimeMs, sessionId }) => ({ path, mtimeMs, ...(sessionId ? { sessionId } : {}) }));
}

export async function discoverRolloutSessions(
  sessionsRoot: string,
  limit: number,
  exclude?: ReadonlySet<string>,
  options: RolloutDiscoveryOptions = {},
): Promise<ResumableSession[]> {
  // The resume id is inside the file (not the filename), so we can't pre-filter
  // by name. Instead walk most-recent-first and parse until `limit` non-excluded
  // sessions are collected — excluded ones cost only a first-line read, so a
  // host with many live sessions doesn't starve the picker.
  const files = await collectRecentJsonl(sessionsRoot, Number.MAX_SAFE_INTEGER, 5);
  const out: ResumableSession[] = [];
  if (options.dialect !== 'traex') {
    for (const f of files) {
      if (out.length >= limit) break;
      const parsed = await parseRolloutTranscript(f.path, f.mtimeMs, exclude, options);
      if (parsed.kind === 'session') out.push(parsed.session);
    }
    return out;
  }
  // TraeX: one candidate per thread. A thread id is decided by its first
  // conclusive segment (in the activity order above); sibling segments are
  // then skipped by filename id without being read, and a rejected id is never
  // resurrected by another segment. Parse count stays bounded exactly as for
  // Codex — files are read until `limit` threads are collected.
  const decided = new Set<string>();
  const candidates = orderTraexRolloutCandidates(files, options);
  // Prompt-derived metadata is loaded per id on demand and prefetched in
  // batches of (threads still needed + DETAILS_PREFETCH_MARGIN) along the
  // activity order, so only threads that are actually parsed — plus a small
  // look-ahead — ever have their prompt columns read.
  const metadata = new Map(options.metadataById);
  const detailsLoaded = new Set<string>();
  const loadDetails = (ids: readonly string[]): void => {
    const missing = options.loadSessionDetails ? ids.filter(id => !detailsLoaded.has(id)) : [];
    if (missing.length === 0) return;
    for (const id of missing) detailsLoaded.add(id);
    for (const [id, details] of options.loadSessionDetails!(missing)) {
      metadata.set(id, { ...metadata.get(id), ...details });
    }
  };
  const lookupMetadata = (id: string): RolloutSessionMetadata | undefined => {
    loadDetails([id]);
    return metadata.get(id);
  };
  for (let i = 0; i < candidates.length; i++) {
    const f = candidates[i]!;
    if (out.length >= limit) break;
    if (f.sessionId && decided.has(f.sessionId)) continue;
    // A live / excluded thread is rejected at its session_meta anyway; skip it
    // before it can trigger a prefetch (its own details are never loaded, so
    // every excluded candidate would otherwise start a fresh look-ahead).
    if (f.sessionId && exclude?.has(f.sessionId)) { decided.add(f.sessionId); continue; }
    if (f.sessionId && options.loadSessionDetails && !detailsLoaded.has(f.sessionId)) {
      const want = limit - out.length + DETAILS_PREFETCH_MARGIN;
      const batch = new Set<string>();
      for (let j = i; j < candidates.length && batch.size < want; j++) {
        const sid = candidates[j]!.sessionId;
        if (sid && !decided.has(sid) && !detailsLoaded.has(sid) && !exclude?.has(sid)) batch.add(sid);
      }
      loadDetails([...batch]);
    }
    const parsed = await parseRolloutTranscript(f.path, f.mtimeMs, exclude, options, lookupMetadata);
    if (parsed.kind === 'rejected') {
      decided.add(parsed.cliSessionId);
    } else if (parsed.kind === 'session' && !decided.has(parsed.session.cliSessionId)) {
      decided.add(parsed.session.cliSessionId);
      out.push(parsed.session);
    }
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
