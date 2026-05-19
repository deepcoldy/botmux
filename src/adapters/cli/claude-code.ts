import { existsSync, statSync, openSync, readSync, closeSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { findJsonlContainingFingerprint, jsonlContainsFingerprint, normaliseForFingerprint } from '../../services/claude-transcript.js';
import { t } from '../../i18n/index.js';

/** Resolve cwd to its canonical (symlink-free) absolute path for project-hash
 *  computation. Claude Code itself runs `process.cwd()` which the kernel returns
 *  already realpath'd via getcwd(3) — so its on-disk project hash always reflects
 *  the realpath, not the symlink we may have spawned it under. We must mirror
 *  that here, otherwise a deployment whose `workingDir` is a symlink (e.g.
 *  `/home/user` → `/data00/home/user`) computes the wrong project dir, the
 *  bridge watcher tails a non-existent file, submit-confirm never sees the
 *  user line, and the no-`botmux send` fallback never emits. realpathSync
 *  throws on non-existent paths — fall back to the raw cwd in that case so a
 *  pre-existence check upstream can still report a useful error. */
function realpathCwd(cwd: string): string {
  try { return realpathSync(cwd); } catch { return cwd; }
}

/** Resolve the JSONL transcript path Claude Code writes user/assistant turns to.
 *  Claude Code's project-hash scheme replaces every non-[A-Za-z0-9-] char with `-`
 *  (observed: `/foo/life_workspace` → `-foo-life-workspace`; `/`, `.`, `_` all become `-`).
 *  Always operates on realpath(cwd) — see realpathCwd above. */
export function claudeJsonlPathForSession(sessionId: string, cwd: string): string {
  const projectHash = realpathCwd(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  return join(homedir(), '.claude', 'projects', projectHash, `${sessionId}.jsonl`);
}

/** Substrings that indicate Claude Code received our submit. We accept either:
 *  - `"role":"user","content":"` — direct submission while idle (the canonical
 *    user-message line; tool-result lines have array content `"content":[{...`
 *    so they never match).
 *  - `"operation":"enqueue"` — type-ahead submission while Claude is busy.
 *    Claude Code logs a `{"type":"queue-operation","operation":"enqueue",...}`
 *    line at the moment of submit and only later (after the current turn ends)
 *    promotes it to a `queued_command` attachment — never to a `role:user`
 *    string-content line. Without this marker, every type-ahead submit would
 *    falsely report failure. */
const SUBMIT_MARKERS = ['"role":"user","content":"', '"operation":"enqueue"'];

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function deltaHasSubmit(path: string, fromByte: number): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;
  const len = size - fromByte;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, fromByte);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString('utf8');
  return SUBMIT_MARKERS.some(m => text.includes(m));
}

async function waitForSubmit(path: string, baseByte: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (deltaHasSubmit(path, baseByte)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

function makeSubmitFingerprint(content: string, len = 30): string | undefined {
  const collapsed = normaliseForFingerprint(content);
  return collapsed.length > 0 ? collapsed.substring(0, len) : undefined;
}

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the absolute path to Claude Code's per-process session state file.
 *  Claude writes `{pid, sessionId, cwd, procStart, status, updatedAt, ...}`
 *  here. Empirical scope (Claude Code 2.1.123): `status` and `updatedAt`
 *  refresh on every state change, but `sessionId` is written ONCE at
 *  process start. `--resume` is a fresh spawn → fresh pid file with the
 *  resumed id; in-pane `/clear` does NOT rewrite the pid file's
 *  `sessionId` even though it rotates the on-disk jsonl. Callers that
 *  rely on this for rotation tracking must therefore treat a "matching
 *  sessionId" answer as "no spawn-time rotation observed", not "no
 *  rotation at all" — the latter requires fingerprint corroboration. */
export function claudePidStatePath(pid: number): string {
  return join(homedir(), '.claude', 'sessions', `${pid}.json`);
}

/** Linux-only: read /proc/<pid>/stat field 22 (starttime). Returns null when
 *  /proc isn't available or the stat line is unreadable/malformed; callers
 *  decide whether to fail closed or skip validation for their platform. */
function readProcStarttime(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid pgrp ... — comm may contain spaces/parens, so
    // anchor on the LAST ')' before splitting the remaining fields.
    const closeParen = raw.lastIndexOf(')');
    if (closeParen < 0) return null;
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
    // Post-')' field 1 is state; starttime is field 22 → index 19 here.
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** Resolve Claude Code's authoritative current session id via
 *  ~/.claude/sessions/<pid>.json. Validates pid + sessionId UUID + cwd so a
 *  stale or unrelated pid file can't redirect us to the wrong jsonl. On Linux
 *  also matches procStart against /proc/<pid>/stat to reject PID reuse. If
 *  procStart is present but cannot be verified on Linux, fail closed; callers
 *  fall back to fingerprint detection. */
export function resolveJsonlFromPid(pid: number, expectedCwd: string): { path: string; cliSessionId: string } | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(claudePidStatePath(pid), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.pid !== pid) return null;
  if (typeof parsed.sessionId !== 'string' || !SESSION_UUID_RE.test(parsed.sessionId)) return null;
  if (typeof parsed.cwd !== 'string') return null;
  // Identity check: procStart matching against /proc/<pid>/stat field 22 is
  // the strong signal that this pid file belongs to the live process (rules
  // out pid reuse). When that holds, Claude's recorded cwd is authoritative
  // even if it disagrees with `expectedCwd` — the worker's cliCwd can drift
  // (e.g. a schedule resumes a session with a different workingDir than the
  // original spawn, but Claude itself loads the session with its own cwd).
  // When procStart is unavailable/unverifiable, fall back to cwd equality as
  // the only remaining sanity check. Realpath both sides so a symlinked
  // workingDir (/home/x → /data00/home/x) still matches Claude's canonical
  // cwd from getcwd(3).
  let procStartVerified = false;
  if (typeof parsed.procStart === 'string') {
    const live = readProcStarttime(pid);
    if (live === null && process.platform === 'linux') return null;
    if (live !== null) {
      if (live !== parsed.procStart) return null;
      procStartVerified = true;
    }
  }
  if (!procStartVerified && realpathCwd(parsed.cwd) !== realpathCwd(expectedCwd)) return null;
  return {
    path: claudeJsonlPathForSession(parsed.sessionId, parsed.cwd),
    cliSessionId: parsed.sessionId,
  };
}

/** Linux-only: probe `/proc/<pid>/fd` for any signal that reveals Claude's
 *  CURRENT sessionId — not the spawn-time one the pid file records. Two
 *  signals are checked:
 *    1. Direct `.jsonl` symlinks under `~/.claude/projects/...` — Claude
 *       opens-writes-closes per event, so this only hits if the probe
 *       lands during a write window.
 *    2. `~/.claude/tasks/<sessionId>(/...)` symlinks — Claude holds the
 *       tasks directory and its `.lock` file open continuously for the
 *       duration of the active session, so this signal is reliable even
 *       between writes. This is the path that catches in-pane `/clear`
 *       rotations the pid file can't see (pid file's `sessionId` is set
 *       once at process start; tasks dir tracks every rotation).
 *  Returns deduplicated sessionIds in arbitrary order; caller picks one
 *  (typically by mtime of the corresponding jsonl). Returns [] on
 *  non-Linux platforms or if /proc lookup fails. */
export function findOpenClaudeSessionIds(pid: number): string[] {
  if (!Number.isInteger(pid) || pid <= 0) return [];
  if (process.platform !== 'linux') return [];
  let entries: string[];
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return [];
  }
  const tasksPrefix = join(homedir(), '.claude', 'tasks') + '/';
  const projectsInfix = '/.claude/projects/';
  const out = new Set<string>();
  for (const name of entries) {
    let target: string;
    try {
      target = readlinkSync(`/proc/${pid}/fd/${name}`);
    } catch {
      continue;
    }
    if (target.startsWith(tasksPrefix)) {
      const sid = target.slice(tasksPrefix.length).split('/')[0];
      if (sid && SESSION_UUID_RE.test(sid)) out.add(sid);
      continue;
    }
    if (target.endsWith('.jsonl') && target.includes(projectsInfix)) {
      const base = target.split('/').pop() ?? '';
      const sid = base.endsWith('.jsonl') ? base.slice(0, -'.jsonl'.length) : '';
      if (sid && SESSION_UUID_RE.test(sid)) out.add(sid);
    }
  }
  return [...out];
}

/** Fingerprint search that fans out from the pinned project dir to every
 *  sibling under `~/.claude/projects/`. Used as the writeInput fallback
 *  when the pinned `claudeJsonlPath` doesn't contain the submit marker —
 *  Claude may have written to a different project hash than the worker
 *  expected (e.g. a schedule resumed the session with a workingDir that
 *  differs from Claude's internal cwd, so the worker computes the wrong
 *  -project-hash- but Claude appends to the original session's hash dir).
 *  Tries the primary dir first (fast path, unchanged behavior); only fans
 *  out when no match is found there. Per-dir, `findJsonlContainingFingerprint`
 *  still applies its newest-first ordering and the minMtimeMs guard, so a
 *  stale historical match in some unrelated project can't false-positive. */
function findJsonlAcrossProjectsRoot(
  searchPath: string,
  fingerprint: string,
  options: { minMtimeMs?: number; includeQueueOperations?: boolean },
): string | null {
  const primaryDir = dirname(searchPath);
  const primary = findJsonlContainingFingerprint(primaryDir, fingerprint, {
    excludePath: searchPath,
    ...options,
  });
  if (primary) return primary;
  const projectsRoot = dirname(primaryDir);
  if (!existsSync(projectsRoot)) return null;
  let siblings: string[];
  try { siblings = readdirSync(projectsRoot); } catch { return null; }
  for (const name of siblings) {
    const sib = join(projectsRoot, name);
    if (sib === primaryDir) continue;
    const matched = findJsonlContainingFingerprint(sib, fingerprint, {
      excludePath: searchPath,
      ...options,
    });
    if (matched) return matched;
  }
  return null;
}

const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed|Baked|Brewed) for \d+[smh]/;

export function createClaudeCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'claude');
  return {
    id: 'claude-code',
    resolvedBin: bin,
    supportsTypeAhead: true,

    buildResumeCommand({ sessionId, cliSessionId }) {
      // Claude resumes by reading <id>.jsonl, so we need the most recently
      // observed CLI-native id (rotation can happen mid-run); fall back to the
      // botmux sessionId for the first-turn case where they coincide.
      return `claude --resume ${cliSessionId ?? sessionId}`;
    },

    buildArgs({ sessionId, resume, resumeSessionId, botName, botOpenId, locale }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', resumeSessionId ?? sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--dangerously-skip-permissions');
      args.push('--disallowed-tools', 'EnterPlanMode,ExitPlanMode');
      const unknown = t('ai.identity.unknown', undefined, locale);
      const identityBlock =
        botName || botOpenId
          ? [
              '',
              '<identity>',
              `  <name>${botName ?? unknown}</name>`,
              `  <open_id>${botOpenId ?? unknown}</open_id>`,
              '  <routing_rules>',
              `    ${t('ai.identity.routing_intro', undefined, locale)}`,
              `    ${t('ai.identity.rule_own_part', undefined, locale)}`,
              `    ${t('ai.identity.rule_silent_when_other', undefined, locale)}`,
              `    ${t('ai.identity.rule_no_proactive_pull', undefined, locale)}`,
              '',
              `    ${t('ai.identity.mention_intro', undefined, locale)}`,
              `    ${t('ai.identity.mention_must', undefined, locale)}`,
              `    ${t('ai.identity.mention_partners', undefined, locale)}`,
              `    ${t('ai.identity.mention_usage', undefined, locale)}`,
              `    ${t('ai.identity.mention_when_to', undefined, locale)}`,
              `    ${t('ai.identity.mention_when_not', undefined, locale)}`,
              '  </routing_rules>',
              '</identity>',
            ]
          : [];
      args.push('--append-system-prompt', [
        '<botmux_routing>',
        t('ai.routing.intro', undefined, locale),
        t('ai.routing.must_use_botmux', undefined, locale),
        '',
        t('ai.routing.usage_heading', undefined, locale),
        t('ai.routing.usage_send_when', undefined, locale),
        t('ai.routing.usage_send_text', undefined, locale),
        t('ai.routing.usage_heredoc', undefined, locale),
        t('ai.routing.heredoc_example', undefined, locale),
        t('ai.routing.usage_images', undefined, locale),
        t('ai.routing.usage_files', undefined, locale),
        t('ai.routing.usage_history', undefined, locale),
        t('ai.routing.usage_bots_list', undefined, locale),
        '</botmux_routing>',
        ...identityBlock,
      ].join('\n'));
      return args;
    },

    injectsSessionContext: true,

    async writeInput(pty, content) {
      // Type content like a human: literal text via send-keys -l, and each
      // newline replaced by `\` + Enter (Claude Code's documented soft-newline
      // idiom — keeps content in the input box without submitting). The final
      // Enter at the bottom is the unambiguous submit. This sidesteps tmux
      // bracketed-paste mode entirely, which was unreliable: Claude Code can
      // toggle bracketed-paste off mid-session (after slash commands etc.),
      // making tmux's paste-buffer drop the markers and turning embedded \r
      // into Enters that fragment the message into multiple submits.
      //
      // Each tmux send-keys is throttled so the cumulative input rate stays
      // below Claude Code's paste-burst threshold — otherwise on long messages
      // (~1300+ chars / ~25+ lines) Ink flips into paste mode mid-stream and
      // subsequent `\` + Enter pairs are kept as literal `\\\r` in the
      // submitted content instead of being consumed as soft-newline markers.
      //
      // Trailing Enter is still subject to Claude Code's paste-burst heuristic
      // (rapid input followed by Enter can be coalesced as paste), so we keep
      // the JSONL retry loop below as the source of truth for "did it submit".
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;
      const TYPING_THROTTLE_MS = 30;

      const tick = () => new Promise<void>(r => setTimeout(r, TYPING_THROTTLE_MS));

      const sendEnter = () => {
        if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
        else pty.write('\r');
      };

      // Pid-state path resolver: ~/.claude/sessions/<pid>.json carries
      // the spawn-time sessionId (written once at process start; see
      // claudePidStatePath). Read it first so byte accounting locks onto
      // the resume target right away when Claude was started with
      // `--resume`. In-pane `/clear` won't appear here — that's covered
      // by the fingerprint-based mid-flight rotation check below.
      let observedCliSessionId: string | undefined;
      const applyResolved = (resolved: { path: string; cliSessionId: string }): boolean => {
        if (resolved.cliSessionId !== observedCliSessionId) observedCliSessionId = resolved.cliSessionId;
        if (resolved.path !== pty.claudeJsonlPath) {
          pty.claudeJsonlPath = resolved.path;
          return true;
        }
        return false;
      };
      if (pty.cliPid && pty.cliCwd) {
        const resolved = resolveJsonlFromPid(pty.cliPid, pty.cliCwd);
        if (resolved) applyResolved(resolved);
      }
      // baseByte is recomputed at this point (after any entry-time path swap)
      // so future writes are measured against the right transcript. Inside
      // confirmSubmit a mid-flight rotation does NOT advance baseByte — the
      // submit may already be in the rotated jsonl from before our re-resolve.
      let baseByte = pty.claudeJsonlPath ? currentFileSize(pty.claudeJsonlPath) : 0;
      const submitFingerprint = makeSubmitFingerprint(content);
      const submitSearchMinMtime = Date.now() - 60_000;

      if (pty.sendText && pty.sendSpecialKeys) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].length > 0) {
            pty.sendText(lines[i]);
            await tick();
          }
          if (i < lines.length - 1) {
            // Soft-newline: backslash + Enter inserts a newline in Claude
            // Code's input box without submitting.
            pty.sendText('\\');
            await tick();
            pty.sendSpecialKeys('Enter');
            await tick();
          }
        }
      } else {
        // Non-tmux fallback (raw PTY): bracketed paste is reliable here since
        // we control the markers directly.
        pty.write('\x1b[200~' + content + '\x1b[201~');
      }
      await new Promise(r => setTimeout(r, submitDelay));
      sendEnter();

      // Without a JSONL path we can't verify — trust the fixed delay and return.
      // Still surface any sessionId we observed via the pid resolver so the
      // worker can persist it even on this unverified path.
      if (!pty.claudeJsonlPath) {
        return observedCliSessionId ? { submitted: true, cliSessionId: observedCliSessionId } : undefined;
      }

      const confirmSubmit = async (timeoutMs: number): Promise<boolean> => {
        const startPath = pty.claudeJsonlPath;
        if (!startPath) return false;

        // First check: did our submit land past baseByte on the currently
        // pinned path? Fast path for the common case (no rotation).
        if (await waitForSubmit(startPath, baseByte, timeoutMs)) return true;

        // Second: did Claude rotate sessionId mid-flight? The pid file
        // is rewritten by `--resume` (fresh spawn) but NOT by in-pane
        // `/clear` — so this catches the resume case. We re-read and
        // check both:
        //   a) the rotated jsonl already contains our submit (the rotation
        //      happened between our type+Enter and this resolve — the
        //      content lives in the new file from before we knew about it),
        //   b) the rotated jsonl is empty / pre-existing but a fresh
        //      append is on its way (briefly poll).
        // We do NOT overwrite the original baseByte before the fingerprint
        // check because (a) requires matching content that may already be in
        // the rotated file. For (b), poll from the rotated file's own current
        // size so an older, larger startPath cannot hide a delayed append.
        if (pty.cliPid && pty.cliCwd) {
          const resolved = resolveJsonlFromPid(pty.cliPid, pty.cliCwd);
          if (resolved) {
            const switched = applyResolved(resolved);
            const newPath = pty.claudeJsonlPath;
            const rotatedBaseByte = switched && newPath ? currentFileSize(newPath) : baseByte;
            if (switched && newPath && submitFingerprint) {
              if (jsonlContainsFingerprint(newPath, submitFingerprint, { includeQueueOperations: true })) {
                // Sync baseByte to end-of-file so subsequent confirms in
                // this writeInput pass don't re-trigger on the same line.
                baseByte = currentFileSize(newPath);
                return true;
              }
            }
            if (newPath) {
              if (await waitForSubmit(newPath, rotatedBaseByte, switched ? 200 : 0)) {
                if (switched) baseByte = currentFileSize(newPath);
                return true;
              }
            }
          }
        }

        // Final fallback when the pid file is unavailable / fails validation:
        // scan the pinned project dir for a recently-written jsonl whose
        // tail contains our content fingerprint. Stricter than mtime-based
        // detection so a sibling pane in the same dir can't hijack us.
        // Per-attempt scope is intentionally narrow (dirname only) — the
        // cross-project fan-out only runs once at end-of-writeInput and in
        // the recheck closure, not per retry, to keep the worst case bounded.
        if (submitFingerprint) {
          const searchPath = pty.claudeJsonlPath ?? startPath;
          const matched = findJsonlContainingFingerprint(dirname(searchPath), submitFingerprint, {
            excludePath: searchPath,
            minMtimeMs: submitSearchMinMtime,
            includeQueueOperations: true,
          });
          if (matched) {
            pty.claudeJsonlPath = matched;
            return true;
          }
        }
        return false;
      };

      const buildResult = (submitted: boolean): { submitted: boolean; cliSessionId?: string } => {
        return observedCliSessionId
          ? { submitted, cliSessionId: observedCliSessionId }
          : { submitted };
      };

      // Retry budget: up to 2 extra Enters (3 sends total), each followed by
      // an 800ms wait for the JSONL to record either a direct user-submit line
      // or a type-ahead enqueue line. If the user is concurrently typing in the
      // web terminal, a stray Enter may submit their half-typed text — but we
      // only retry when the JSONL is provably unchanged, so the race window is
      // bounded to cases where submit really did fail.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await confirmSubmit(800)) {
          return observedCliSessionId ? buildResult(true) : undefined;
        }
        sendEnter();
      }
      // Final grace check.
      if (await confirmSubmit(800)) {
        return observedCliSessionId ? buildResult(true) : undefined;
      }
      // Last-resort cross-project fan-out, run ONCE before declaring failure:
      // catches the case where workingDir/cwd drift made every per-attempt
      // scan look in the wrong project dir AND the pid resolver also failed
      // (e.g. pid file missing, /proc unavailable). minMtimeMs filtering and
      // newest-first ordering keep the cost bounded — only jsonls touched in
      // the last 60s are actually read, which is typically a handful even
      // across all sibling project dirs. Per-attempt scans stay narrow
      // (dirname only) so this work doesn't repeat 4×.
      if (submitFingerprint && pty.claudeJsonlPath) {
        const matched = findJsonlAcrossProjectsRoot(pty.claudeJsonlPath, submitFingerprint, {
          minMtimeMs: submitSearchMinMtime,
          includeQueueOperations: true,
        });
        if (matched) {
          pty.claudeJsonlPath = matched;
          return observedCliSessionId ? buildResult(true) : undefined;
        }
      }
      // All retries exhausted and still no submit marker in JSONL. Signal failure
      // so the worker can notify the user in Lark instead of silently dropping.
      // We still surface observedCliSessionId so the worker can persist Claude's
      // current id even when this particular submit didn't land.
      //
      // Attach a recheck closure: the in-band budget (4 × 800ms) is too short
      // for cold-start sessions and for environments where a slow third-party
      // UserPromptSubmit / SessionStart hook (e.g. superpowers) defers Claude's
      // jsonl append by 5–15s. The worker calls recheck() after a delay, and
      // suppresses the user-facing warning when the line shows up by then.
      const recheck = (): boolean => {
        if (!submitFingerprint) return false;
        // Latest pid → path; covers post-failure rotations (/clear, /resume).
        if (pty.cliPid && pty.cliCwd) {
          const resolved = resolveJsonlFromPid(pty.cliPid, pty.cliCwd);
          if (resolved) applyResolved(resolved);
        }
        const currentPath = pty.claudeJsonlPath;
        if (currentPath && jsonlContainsFingerprint(currentPath, submitFingerprint, { includeQueueOperations: true })) {
          return true;
        }
        // Fan out to sibling jsonls in the project dir, then across every
        // sibling project dir under `~/.claude/projects/` (catches workingDir
        // drift like worker thinking `-foo-bar/` while Claude actually appends
        // to `-foo-bar-baz/`). Same minMtime guard as the in-band fingerprint
        // fallback so a stale historical match can't suppress the warning.
        const searchPath = currentPath ?? pty.claudeJsonlPath;
        if (!searchPath) return false;
        const matched = findJsonlAcrossProjectsRoot(searchPath, submitFingerprint, {
          minMtimeMs: submitSearchMinMtime,
          includeQueueOperations: true,
        });
        return !!matched;
      };
      return { ...buildResult(false), recheck };
    },

    completionPattern: COMPLETION_RE,
    readyPattern: /❯/,
    systemHints: [],
    altScreen: false,
    skillsDir: '~/.claude/skills',
  };
}

export const create = createClaudeCodeAdapter;
