import { existsSync, statSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';
import { findJsonlContainingFingerprint, jsonlContainsFingerprint, normaliseForFingerprint } from '../../services/claude-transcript.js';

/** Resolve the JSONL transcript path Claude Code writes user/assistant turns to.
 *  Claude Code's project-hash scheme replaces every non-[A-Za-z0-9-] char with `-`
 *  (observed: `/foo/life_workspace` → `-foo-life-workspace`; `/`, `.`, `_` all become `-`). */
export function claudeJsonlPathForSession(sessionId: string, cwd: string): string {
  const projectHash = cwd.replace(/[^A-Za-z0-9-]/g, '-');
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
  if (typeof parsed.cwd !== 'string' || parsed.cwd !== expectedCwd) return null;
  if (typeof parsed.procStart === 'string') {
    const live = readProcStarttime(pid);
    if (live === null && process.platform === 'linux') return null;
    if (live !== null && live !== parsed.procStart) return null;
  }
  return {
    path: claudeJsonlPathForSession(parsed.sessionId, parsed.cwd),
    cliSessionId: parsed.sessionId,
  };
}

const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed) for \d+[smh]/;

export function createClaudeCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'claude');
  return {
    id: 'claude-code',
    resolvedBin: bin,
    supportsTypeAhead: true,

    buildArgs({ sessionId, resume, resumeSessionId, botName, botOpenId }) {
      const args: string[] = [];
      if (resume) {
        // Prefer Claude's most recently observed internal session id when we
        // have one — `--resume` reads `<id>.jsonl`, and after a previous run
        // rotated the id (which we now persist via the pid-file resolver) the
        // botmux sessionId no longer matches Claude's actual transcript file.
        args.push('--resume', resumeSessionId ?? sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      args.push('--dangerously-skip-permissions');
      args.push('--disallowed-tools', 'EnterPlanMode,ExitPlanMode');
      const identityBlock =
        botName || botOpenId
          ? [
              '',
              '<identity>',
              `  <name>${botName ?? '(未知)'}</name>`,
              `  <open_id>${botOpenId ?? '(未知)'}</open_id>`,
              '</identity>',
              '同一群里可能有多个机器人同时被 @，消息里会以 `@名字` 和 `open_id` 区分。',
              '判断本条消息是不是分派给你：对照上面的名字和 open_id。',
              '- 只执行明确分给自己的那部分，别抢别的机器人的活',
              '- 整条消息都指派给别的机器人时，保持沉默不要回复',
              '- 需要找对端协作时先用 `botmux bots list` 查 open_id，再用 `botmux send --mention <open_id>` @ 对方',
            ]
          : [];
      args.push('--append-system-prompt', [
        '<botmux_routing>',
        '你连接到了飞书（Lark）话题群。用户在飞书上阅读，看不到你的终端输出。',
        '想让用户看到的内容必须通过 `botmux send` 命令发送，终端输出不会到达聊天。',
        '',
        '使用指南：',
        '- 用 `botmux send` 发送：关键结论、方案（等用户确认再执行）、最终结果、进度更新。',
        '- 发送纯文本即可：`botmux send "消息"` 或用 heredoc 传多行。格式自动处理。',
        '- 附带图片：`botmux send --images /path/to/img.png "说明文字"`',
        '- 附带文件：`botmux send --files /path/to/file.pdf "请查收"`',
        '- 需要上下文时用 `botmux thread messages` 读取之前的对话。',
        '- 查看可协作的机器人：`botmux bots list`',
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
        // scan the project dir for a recently-written jsonl whose tail
        // contains our content fingerprint. Stricter than mtime-based
        // detection so a sibling pane in the same dir can't hijack us.
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
      // All retries exhausted and still no submit marker in JSONL. Signal failure
      // so the worker can notify the user in Lark instead of silently dropping.
      // We still surface observedCliSessionId so the worker can persist Claude's
      // current id even when this particular submit didn't land.
      return buildResult(false);
    },

    completionPattern: COMPLETION_RE,
    readyPattern: /❯/,
    systemHints: [],
    altScreen: false,
    skillsDir: '~/.claude/skills',
  };
}

export const create = createClaudeCodeAdapter;
