import { existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCommand } from './registry.js';
import type { CliAdapter, PtyHandle } from './types.js';

/** Resolve the JSONL transcript path Claude Code writes user/assistant turns to.
 *  Claude Code's project-hash scheme replaces every non-[A-Za-z0-9-] char with `-`
 *  (observed: `/foo/life_workspace` → `-foo-life-workspace`; `/`, `.`, `_` all become `-`). */
export function claudeJsonlPathForSession(sessionId: string, cwd: string): string {
  const projectHash = cwd.replace(/[^A-Za-z0-9-]/g, '-');
  return join(homedir(), '.claude', 'projects', projectHash, `${sessionId}.jsonl`);
}

/** Substring that appears on every real user submission line and NOT on tool-result
 *  lines (those have array content: `"content":[{...}]`). */
const USER_SUBMIT_MARKER = '"role":"user","content":"';

function currentFileSize(path: string): number {
  if (!existsSync(path)) return 0;
  try { return statSync(path).size; } catch { return 0; }
}

function deltaHasUserSubmit(path: string, fromByte: number): boolean {
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
  return buf.toString('utf8').includes(USER_SUBMIT_MARKER);
}

async function waitForUserSubmit(path: string, baseByte: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (deltaHasUserSubmit(path, baseByte)) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const COMPLETION_RE = /\u2733\s*(?:Worked|Crunched|Cogitated|Cooked|Churned|Saut[eé]ed) for \d+[smh]/;

export function createClaudeCodeAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'claude');
  return {
    id: 'claude-code',
    resolvedBin: bin,
    supportsTypeAhead: true,

    buildArgs({ sessionId, resume, botName, botOpenId }) {
      const args: string[] = [];
      if (resume) {
        args.push('--resume', sessionId);
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

      const baseByte = pty.claudeJsonlPath ? currentFileSize(pty.claudeJsonlPath) : 0;

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
      if (!pty.claudeJsonlPath) return;

      // Retry budget: up to 2 extra Enters (3 sends total), each followed by
      // an 800ms wait for the JSONL append. If the user is concurrently typing
      // in the web terminal, a stray Enter may submit their half-typed text —
      // but we only retry when the JSONL is provably unchanged, so the race
      // window is bounded to cases where submit really did fail.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (await waitForUserSubmit(pty.claudeJsonlPath, baseByte, 800)) return;
        sendEnter();
      }
      // Final grace check.
      if (await waitForUserSubmit(pty.claudeJsonlPath, baseByte, 800)) return;
      // All retries exhausted and still no user line in JSONL. Signal failure
      // so the worker can notify the user in Lark instead of silently dropping.
      return { submitted: false };
    },

    completionPattern: COMPLETION_RE,
    readyPattern: /❯/,
    systemHints: [],
    altScreen: false,
    skillsDir: '~/.claude/skills',
  };
}

export const create = createClaudeCodeAdapter;
