/**
 * Grok Build path helpers.
 *
 * Layout (see `~/.grok/README.md` Session Persistence):
 *   $GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/
 *     summary.json
 *     updates.jsonl      — ACP session update stream (bridge source of truth)
 *     chat_history.jsonl
 *     …
 *   $GROK_HOME/sessions/<url-encoded-cwd>/prompt_history.jsonl
 *     — bucket-level submit log: one `{timestamp, session_id, prompt, is_bash}`
 *       line per submit. Submit-verify reads this file. Grok 1.0.x writes a
 *       type-ahead follow-up at dequeue, and may omit the line; updates.jsonl
 *       has the same timing, so neither can confirm a busy-turn submit.
 *   $GROK_HOME/sessions/session_search.sqlite
 *   $GROK_HOME/skills/
 *   $GROK_HOME/hooks/
 *   $GROK_HOME/auth.json
 *
 * When the URL-encoded cwd exceeds 255 bytes, Grok uses a slug+hash bucket
 * name and records the real path in a `.cwd` file inside that group. Path
 * helpers resolve via {@link resolveGrokCwdBucketDir} so prompt_history /
 * session dirs stay correct for long / CJK working directories.
 *
 * Grok names buckets from getcwd() (the physical path). Botmux often holds
 * the logical cwd — HOME is a symlink on some hosts (`/home/user` →
 * `/data00/home/user`). Resolve both encodings so submit-verify can find
 * prompt_history.jsonl; otherwise writeInput fail-closes for 20s with
 * submit_unconfirmed even though Enter already landed.
 *
 * GROK_HOME is process-level only (daemon env / shell). Per-bot `env.GROK_HOME`
 * is reserved — botmux installs hooks/skills and drains transcripts under the
 * daemon-resolved home; injecting a different home into the CLI only would
 * split-brain (see per-bot-env RESERVED_ENV_KEYS).
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Grok's documented max length for an encoded cwd bucket name (bytes). */
export const GROK_ENCODED_CWD_MAX_BYTES = 255;

/** Resolve GROK_HOME (env override, else `~/.grok`). */
export function grokHome(): string {
  const override = process.env.GROK_HOME?.trim();
  return override && override.length > 0 ? override : join(homedir(), '.grok');
}

export function grokSessionsRoot(): string {
  return join(grokHome(), 'sessions');
}

export function grokSkillsDir(): string {
  return join(grokHome(), 'skills');
}

export function grokHooksDir(): string {
  return join(grokHome(), 'hooks');
}

/** URL-encode a working directory the way Grok names session buckets. */
export function encodeGrokCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

/** Physical path Grok's getcwd() would report; original cwd if realpath fails. */
function canonicalizeGrokCwd(cwd: string): string {
  // trim() only tests emptiness — POSIX directory names may end in spaces.
  if (!cwd.trim()) return cwd;
  try {
    return realpathSync(cwd);
  } catch {
    return cwd;
  }
}

function grokCwdVariants(cwd: string): string[] {
  if (!cwd.trim()) return [cwd];
  const canonical = canonicalizeGrokCwd(cwd);
  return canonical === cwd ? [cwd] : [cwd, canonical];
}

function grokCwdMatchesMarker(marker: string, cwd: string): boolean {
  const markerTrim = marker.trim();
  if (marker === cwd || markerTrim === cwd) return true;
  return canonicalizeGrokCwd(markerTrim) === canonicalizeGrokCwd(cwd);
}

function grokBucketHasPromptHistory(dir: string): boolean {
  return existsSync(join(dir, 'prompt_history.jsonl'));
}

function collectHashedBucketDirs(root: string, variants: string[]): string[] {
  const hits: string[] = [];
  if (!existsSync(root)) return hits;
  try {
    for (const name of readdirSync(root)) {
      if (name.endsWith('.sqlite') || name.endsWith('.lock')) continue;
      const dir = join(root, name);
      const marker = join(dir, '.cwd');
      if (!existsSync(marker)) continue;
      try {
        const raw = readFileSync(marker, 'utf8').replace(/\r?\n$/, '');
        if (variants.some((candidate) => grokCwdMatchesMarker(raw, candidate))) {
          hits.push(dir);
        }
      } catch { /* ignore unreadable marker */ }
    }
  } catch { /* ignore unreadable root */ }
  return hits;
}

/**
 * Resolve the on-disk sessions bucket directory for `cwd`.
 *
 * 1. Encoded dirs for `cwd` / realpath(cwd) that already have
 *    prompt_history.jsonl return immediately. Empty encoded dirs continue
 *    so they cannot shadow a physical / hashed bucket that has history.
 * 2. Else hashed buckets whose `.cwd` matches either; then the first
 *    existing encoded dir, then the first hashed match.
 * 3. If nothing exists yet, return the encoded physical path Grok will
 *    create from getcwd(); fall back to encoding `cwd` when realpath fails.
 */
export function resolveGrokCwdBucketDir(cwd: string): string {
  const root = grokSessionsRoot();
  const variants = grokCwdVariants(cwd);

  const encodedHits: string[] = [];
  for (const candidate of variants) {
    const dir = join(root, encodeGrokCwd(candidate));
    if (!existsSync(dir)) continue;
    // Encoded dir with prompt_history is already the best hit — skip the
    // hashed-bucket scan (empty dirs still fall through so they cannot
    // shadow a physical / hashed bucket that actually has history).
    if (grokBucketHasPromptHistory(dir)) return dir;
    encodedHits.push(dir);
  }
  const hashedHits = collectHashedBucketDirs(root, variants);
  const withHistory = [...encodedHits, ...hashedHits].find(grokBucketHasPromptHistory);
  if (withHistory) return withHistory;
  if (encodedHits.length > 0) return encodedHits[0];
  if (hashedHits.length > 0) return hashedHits[0];
  return join(root, encodeGrokCwd(canonicalizeGrokCwd(cwd)));
}

export function grokSessionDir(sessionId: string, cwd: string): string {
  return join(resolveGrokCwdBucketDir(cwd), sessionId);
}

export function grokUpdatesPath(sessionId: string, cwd: string): string {
  return join(grokSessionDir(sessionId, cwd), 'updates.jsonl');
}

/** Bucket-level submit log (see header) — one line per submit across all
 *  sessions in this cwd. Resolves hashed buckets via `.cwd` when needed. */
export function grokPromptHistoryPath(cwd: string): string {
  return join(resolveGrokCwdBucketDir(cwd), 'prompt_history.jsonl');
}

export function grokSummaryPath(sessionId: string, cwd: string): string {
  return join(grokSessionDir(sessionId, cwd), 'summary.json');
}
