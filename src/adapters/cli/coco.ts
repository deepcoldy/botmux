import { execFile } from 'node:child_process';
import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import { parseDebugModelsJson } from './model-catalog-json.js';
import { cocoCacheRoot } from '../../services/coco-paths.js';
import { traeHistoryPath } from '../../services/traex-paths.js';
import { traexHistoryMatchDelta } from '../../services/traex-transcript.js';
import { delay, scaleMs } from '../../utils/timing.js';
import { installCocoAskPlugin } from '../coco-ask-plugin.js';
import { TRAE_MIGRATION_DONE_MARKERS } from './traex.js';
import type { CliAdapter, PtyHandle } from './types.js';

/** Legacy global submit log — CoCo / traecli <0.201.5 appends one JSON line
 *  here on every successful user submit across all sessions (mode:"user").
 *  Format observed: `{"content":"...","mode":"user","timestamp":"..."}`.
 *  Still polled for old traecli builds that keep writing here.
 *
 *  traecli 0.201.5+ moved the submit log to `$TRAE_HOME/cli/history.jsonl`
 *  (see traeHistoryPath) in the Codex-shaped `{session_id, ts, text}` format —
 *  the same file the traex adapter polls. Coco runs the SAME traecli binary,
 *  so writeInput polls BOTH paths and confirms on whichever records our
 *  submit; neither path is computed at module load (TRAE_HOME may be set
 *  after process start). */

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

/** Scan `path` for a JSON line newer than `fromByte` that's a user-submit
 *  whose decoded `content` starts with `prefix`. Parses each candidate line
 *  with JSON.parse — substring match on the raw bytes is unreliable here
 *  because CoCo's Go marshaller HTML-escapes `<`, `>`, `&` into `<`,
 *  `>`, `&`, which our string-form prefix won't match. Decoding
 *  the field and comparing JS strings sidesteps all of that.
 *
 *  `fromByte` is captured as the file size at submit time, but CoCo/Trae
 *  0.120.32 appends to history.jsonl NON-ATOMICALLY, so that baseline can land
 *  in the MIDDLE of a JSONL line — including the very line that ends up
 *  carrying our marker. Reading straight from `fromByte` would yield a mid-line
 *  fragment (`...sender type=\"user\"...`) that fails JSON.parse, so the marker
 *  line gets skipped and we falsely report "not submitted" — the user sees a
 *  spurious submit-failure warning even though CoCo received and replied.
 *
 *  Fix: back up to the start of the line that contains `fromByte` and parse
 *  whole lines, but only accept lines whose END is past `fromByte` (newly
 *  written / spanning the baseline) so a stale earlier record that happens to
 *  share the prefix can't produce a false positive. */
function historyDeltaContains(path: string, fromByte: number, prefix: string): boolean {
  if (!existsSync(path)) return false;
  let size: number;
  try { size = statSync(path).size; } catch { return false; }
  if (size <= fromByte) return false;

  // Read from a little before `fromByte` so the line straddling the baseline is
  // captured whole. A single chat-prompt JSONL line stays far under 64 KiB.
  const LOOKBACK = 64 * 1024;
  const readStart = Math.max(0, fromByte - LOOKBACK);
  const len = size - readStart;
  const buf = Buffer.alloc(len);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, len, readStart);
  } finally {
    closeSync(fd);
  }

  // Walk complete lines, tracking each line's absolute end offset in the file.
  let lineStart = 0;
  if (readStart > 0) {
    // We may have started mid-line; the bytes before the first newline belong
    // to a line whose head we can't see — skip that partial fragment.
    const firstNl = buf.indexOf(0x0a);
    if (firstNl === -1) return false;
    lineStart = firstNl + 1;
  }
  while (lineStart < buf.length) {
    const nl = buf.indexOf(0x0a, lineStart);
    const lineEnd = nl === -1 ? buf.length : nl;
    const absLineEnd = readStart + lineEnd;
    // Only lines that extend past the baseline are this submit's; skip the rest.
    if (absLineEnd > fromByte) {
      const line = buf.toString('utf8', lineStart, lineEnd);
      if (line.includes('"mode":"user"')) {
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed.content === 'string' && parsed.content.startsWith(prefix)) {
            return true;
          }
        } catch {
          // Truncated tail / non-JSON line — keep scanning the rest.
        }
      }
    }
    if (nl === -1) break;
    lineStart = nl + 1;
  }
  return false;
}

async function waitForConfirm(confirm: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + scaleMs(timeoutMs);
  while (Date.now() < deadline) {
    if (confirm()) return true;
    await delay(100);
  }
  return false;
}

/** First 40 chars of the original content — used as a prefix match against
 *  the JSON-decoded `content` field of each user-mode line in history.jsonl.
 *  Compare against decoded strings, NOT against raw file bytes: CoCo's Go
 *  marshaller HTML-escapes `<`, `>`, `&` so a JSON-encoded marker wouldn't
 *  match the stored bytes. 40 chars is unique enough across concurrent bots. */
function submitPrefix(content: string): string {
  return content.slice(0, 40);
}

export function createCocoAdapter(pathOverride?: string): CliAdapter {
  // resolvedBin is lazy: setup constructs adapters only to read static
  // modelChoices and must not shell out (see resolveCommand); the binary path
  // is a spawn-time concern.
  const rawBin = pathOverride ?? 'coco';
  let cachedBin: string | undefined;
  return {
    id: 'coco',
    // ~/.trae/cli kept REAL (shared with traex): login + shared Trae state incl.
    // the codex-style SQLite DBs (fcntl locks don't work unless the dir is bound
    // real). ~/.cache/coco kept REAL too: the transcript bridge reads events.jsonl
    // at the REAL ~/.cache/coco/sessions/<sid>/ path (see coco-transcript.ts) —
    // without the rw bind the CLI's writes would be invisible to the daemon.
    // NOT widened to the whole ~/.trae (that root holds hooks/plugins/skills/
    // traecli.toml, and authPaths are readWrite → a chat-driven sandbox could
    // mutate shared hook/plugin code). Coco runs the SAME traecli binary as traex,
    // so it hits the same first-run migration prompt; the done-markers it needs
    // are exposed READ-ONLY via sandboxReadonlyPaths() below.
    authPaths: ['~/.trae/cli', '~/.cache/coco'],
    sandboxReadonlyPaths: () => [...TRAE_MIGRATION_DONE_MARKERS],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, model, disableCliBypass }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
      if (!disableCliBypass) args.push('--yolo');
      if (model && model.trim()) {
        // CoCo expects nested key path for model override. `model=...` exits 1,
        // while `model.name=...` starts correctly.
        args.push('--config', `model.name=${model.trim()}`);
      }
      args.push('--disallowed-tool', 'EnterPlanMode', '--disallowed-tool', 'ExitPlanMode');
      return args;
    },

    buildResumeCommand({ sessionId }) {
      return `coco --resume ${sessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // CoCo / Trae CLI is a Claude Code fork (Ink TUI) with two failure modes
      // for multi-line input:
      //   1. tmux `send-keys -l` treats each \n as Enter — multi-line content
      //      either submits line-by-line or paste-burst-coalesces with the
      //      trailing Enter consumed as part of the paste (text stays stuck
      //      in the input box, never submitted).
      //   2. The old adapter had no verification, so the worker never knew
      //      and the user stared at Lark waiting for a reply that never came.
      //
      // Fix: use tmux `load-buffer` + `paste-buffer -d -p` (the `pasteText`
      // path). The `-p` flag is what makes tmux wrap the content in
      // bracketed-paste markers (`\e[200~...\e[201~`) when the Ink TUI has
      // bracketed paste enabled — Ink does by default on fresh spawn. WITHOUT
      // `-p` tmux pastes raw bytes (no markers) and we're back to the burst
      // bug below. CoCo sees an explicit START/END
      // pair, so embedded `\n` stay as content (no per-line submits) and the
      // trailing Enter after submitDelay is unambiguously a submit (not part
      // of an "ongoing paste burst" the way send-keys -l rapid input was).
      //
      // Why not send-keys -l + `\` + Enter soft-newlines (the claude-code
      // pattern): on Trae CLI 0.120.31 (May 2026 build), fresh-spawned CoCo
      // treats the rapid send-keys sequence as an open-ended paste burst and
      // swallows the final Enter as a soft-newline — message stranded in the
      // input box with no submit, no error. Manually pressing Enter 30 min
      // later still works (burst window times out eventually), so the issue
      // is "burst never terminates from CoCo's POV", which an explicit
      // bracketed-paste END marker fixes. claude-code.ts keeps its
      // send-keys-typing path because Claude Code can toggle bracketed paste
      // OFF after slash commands; CoCo on a fresh-spawn message doesn't have
      // that concern.
      const hasImagePath = /\.(jpe?g|png|gif|webp|svg|bmp)\b/i.test(content);
      const submitDelay = hasImagePath ? 800 : 500;

      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          // tmux session is gone (CLI exited mid-write) — bail cleanly
          // rather than crashing the worker on unhandled execFileSync.
          return false;
        }
      };

      // Verification: poll BOTH submit logs for our marker and confirm on
      // whichever records it. The legacy ~/.cache/coco/history.jsonl uses
      // mode+content PREFIX matching (historyDeltaContains); the new
      // $TRAE_HOME/cli/history.jsonl uses Codex-shaped {session_id,ts,text}
      // EXACT matching (traexHistoryMatchDelta, shared with the traex adapter).
      // Paths are resolved per submit so a TRAE_HOME set after process start
      // is honored. Retry Enter up to 3 times, then return
      // {submitted:false, recheck} for the worker's deferred recheck + Lark
      // warning path.
      const legacyHistoryPath = join(cocoCacheRoot(), 'history.jsonl');
      const traeHistory = traeHistoryPath();
      const baseByteLegacy = currentFileSize(legacyHistoryPath);
      const baseByteTrae = currentFileSize(traeHistory);
      const prefix = submitPrefix(content);

      // Submit confirmation is ownership-INDEPENDENT: any full-content match
      // in either global submit log proves the Enter committed (mirrors the
      // traex adapter's anyMatch rationale — a foreign-first line or absent
      // pid must never suppress the confirmation).
      const submitConfirmed = (): boolean =>
        historyDeltaContains(legacyHistoryPath, baseByteLegacy, prefix)
        || traexHistoryMatchDelta(traeHistory, baseByteTrae, content).found;

      try {
        if (pty.pasteText) {
          // tmux mode: load-buffer + paste-buffer -d -p. The `-p` flag (added
          // in TmuxPipeBackend.pasteText — the real runtime backend) makes tmux
          // emit bracketed-paste markers when the pane has them on (Ink
          // default); without it the trailing Enter is swallowed as a soft
          // newline and the message strands. `-d` deletes the buffer after
          // pasting so it doesn't accumulate across writes.
          pty.pasteText(content);
        } else {
          // Non-tmux fallback (raw PTY): wrap markers ourselves.
          pty.write('\x1b[200~' + content + '\x1b[201~');
        }
      } catch {
        return { submitted: false };
      }
      await delay(submitDelay);
      if (!trySendEnter()) return { submitted: false };

      // Fresh-install short-wait: when BOTH submit logs are absent at submit
      // time, give CoCo up to 1.2s to create one. If our marker shows up →
      // success. If both files are still absent → trust the Enter and return
      // (this is the genuine "first run / coco doesn't write history"
      // case). If a file appeared but our marker isn't there → fall
      // through to the normal retry/failure loop — better to warn than to
      // silently mask a real submit failure on a new install.
      if (!existsSync(legacyHistoryPath) && !existsSync(traeHistory)) {
        if (await waitForConfirm(submitConfirmed, 1200)) {
          return { submitted: true };
        }
        if (!existsSync(legacyHistoryPath) && !existsSync(traeHistory)) {
          return undefined;
        }
        // A file appeared during the wait but our marker isn't in it — fall
        // through to the retry loop. The baselines stay 0 for the file that
        // was absent, so the loop scans its whole content.
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForConfirm(submitConfirmed, 800)) {
          return { submitted: true };
        }
        if (!trySendEnter()) return { submitted: false };
      }
      if (await waitForConfirm(submitConfirmed, 800)) {
        return { submitted: true };
      }
      // In-band budget exhausted. Hand the worker a recheck closure: a slow
      // CoCo (cold start, large initial prompt, heavy hooks) may still
      // append our marker after retries gave up. Worker re-scans after a
      // delay before deciding whether to warn the user.
      const recheck = (): boolean => submitConfirmed();
      return { submitted: false, recheck };
    },

    completionPattern: undefined,
    // `⏵⏵` only shows when CoCo runs with --yolo (bypass permissions). Adopted
    // CoCo processes started by the user manually usually don't have that flag,
    // so the status bar shows just the model badge `⬡ <model>` instead. Match
    // either — without this, idle detection never fires for adopt mode and the
    // transcript bridge never drains.
    readyPattern: /⏵⏵|⬡/,
    systemHints: BOTMUX_SHELL_HINTS,
    // CoCo 0.120.32+ accepts a new message while the current turn is still
    // running: it parks it in the TUI's own queue ("↑ Press up to edit queued
    // messages") and processes it after the current turn finishes — input is
    // neither dropped nor garbled (the earlier concern that downgraded CoCo to
    // wait-for-idle). Crucially it writes the queued message's events.jsonl
    // user event only at DEQUEUE time, so the transcript the bridge fallback
    // reads stays interleaved (user1 → asst1 → user2 → asst2) and the
    // CodexBridgeQueue's single-`collecting` attribution stays correct without
    // the queued_command upgrade Claude needed. The submit log history.jsonl
    // IS written at submit time (even for a queued message), so writeInput's
    // verification still confirms the submit. Codex (0.134.0+) also runs with
    // type-ahead, but via an active-turn steer rather than CoCo's strict
    // dequeue-deferral — see codex.ts and CodexBridgeQueue's HOL-block-drop.
    supportsTypeAhead: true,
    altScreen: false,
    // AskUserQuestion 接管：装一个 CoCo 插件（hooks.json: PreToolUse/AskUserQuestion）
    // 把事件转发到 `botmux hook coco`，弹成飞书选择卡。CoCo 的 hook 不能用 directive
    // 代答，答案由 daemon 在结算后按键驱动原生 picker 回灌（见 coco-picker-keys.ts +
    // daemon /api/asks coco 分支 + worker driveCocoPicker）。asksViaHook 置 true 以
    // 关掉 botmux-ask skill 兜底，避免 skill 与 hook 双重弹卡。
    asksViaHook: true,
    ensureAskHook() { installCocoAskPlugin(this.resolvedBin); },
    // CoCo/Trae CLI reads the same skill root as the Trae-flavoured adapter.
    skillsDir: '~/.trae/skills',
    modelChoices: [
      'Seed-Dogfooding-2.0',
      'Doubao-Seed-2.0-Code',
      'Doubao-Seed-Code',
      'Gemini-3.1-Pro-Preview',
    ],
    // Live 模型枚举：coco 与 traex 共用同一 traecli 二进制（见 coco.ts 顶部
    // 说明），`coco debug models` 输出与 `traex debug models` 同构的 JSON 目录，
    // 复用共享解析。整包可达数百 KB，故 maxBuffer 给到 16MB、8s 超时兜底。
    // 仅 dashboard 在用户选中 coco 时按需调用，不在 daemon/worker 启动路径上；
    // 任何异常（spawn 失败/超时/输出非法）一律 fail-soft 返回 null，picker
    // 回退到上面的 modelChoices。
    async detectModels(): Promise<readonly string[] | null> {
      try {
        // lazy promisify：顶层 promisify(execFile) 会在部分 mock child_process
        // 的测试 import 阶段炸（mock 无 execFile 导出）；推迟到调用时，fail-soft
        // 的 try/catch 兜住（契约：任何异常 → null）。
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync(this.resolvedBin, ['debug', 'models'], {
          timeout: 8000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        const models = parseDebugModelsJson(stdout);
        return models.length > 0 ? models : null;
      } catch {
        return null;
      }
    },
  };
}

export const create = createCocoAdapter;
