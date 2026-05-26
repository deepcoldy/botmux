import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kimi Code CLI 适配器（MoonshotAI/kimi-cli，实测版本 1.44.0）。
 *
 * 文档：https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html
 *
 * 已实测确认（`kimi --help` + 登录后 PTY 探针 + 读源码）：
 *   - 主交互界面是 prompt_toolkit 的 PromptSession（行内 REPL），**不进 alt screen**
 *     （启动只发一个 OSC 设标题 `\e]0;Kimi Code\a`）→ altScreen: false。
 *   - 输入框就绪时渲染一个带边框的输入区：`── input ──────…`（不是裸 `> ` 提示符）。
 *   - **bracketed paste 已开启**（PTY 探针见 `\e[?2004h`）→ writeInput 走 coco 同款
 *     paste-buffer -p（整段含 \n 作为一次粘贴进输入框）+ 延迟 Enter 提交。
 *   - --yolo / -y = 自动批准所有动作，但**不**吞 AskUserQuestion；--afk 才会
 *     auto-dismiss AskUserQuestion。botmux 要把提问转发回飞书，故用 --yolo。
 *   - --work-dir / -w 指定工作目录。
 *   - resume 形态：`kimi -r <uuid>` / `--resume <uuid>`（退出时会打印
 *     "To resume this session: kimi -r <uuid>"，启动 banner 也显示 "Session: <uuid>"）。
 *   - 会话落盘：~/.kimi/sessions/<md5(workdir)>/<session_id>/context.jsonl。
 *   - skill 发现：默认合并 ~/.kimi/skills、~/.claude/skills、~/.config/agents/skills
 *     （merge_all_available_skills 默认 true）；每个 skill 一个含 SKILL.md 的目录，
 *     frontmatter name/description，与 botmux skill 格式一致 → 写 ~/.kimi/skills。
 *
 * ⚠️ 仍需用「装好模型的登录」实测一次（裸 `kimi login` 子命令只存了 OAuth token、
 * 没把 managed provider/模型写进 config，需在 REPL 里跑 /login 选模型，否则 LLM not set）：
 *   1. writeInput：确认整段多行经 bracketed paste 一次性提交、尾 Enter 不被吞成软换行。
 *   2. readyPattern：候选 `── input ─`（已见渲染），但不确定每个 prompt 周期是否都重发
 *      到原始流；为避免"只匹配一次后 idle 永久被抑制"的坑，v1 先留空靠 quiescence，
 *      待确认边框每轮重绘后再收紧。
 *
 * 注意（无人值守）：kimi 启动有「发现新版本时阻塞提示升级」的 gate，会卡住 spawn。
 * 建议在 bot 运行环境里设 `KIMI_CLI_NO_AUTO_UPDATE=1` 关掉它。
 *
 * 未来增强：spawn 前快照 ~/.kimi/sessions/<md5(workdir)>/ 下的目录，spawn 后取新增
 * 的那个目录名作为本话题的 cliSessionId 回填 → 实现精确 resume（多话题共用 workingDir
 * 时也不串台）。当前 v1 仅在 worker 已持有 resumeSessionId 时精确续，否则起新会话。
 */
export function createKimiAdapter(pathOverride?: string): CliAdapter {
  const bin = resolveCommand(pathOverride ?? 'kimi');
  return {
    id: 'kimi',
    resolvedBin: bin,

    buildArgs({ resume, resumeSessionId, workingDir }) {
      const base: string[] = [];
      if (workingDir) base.push('--work-dir', workingDir);
      // --yolo 自动批准工具调用（不 dismiss AskUserQuestion），否则无人值守会卡权限确认。
      base.push('--yolo');
      if (!resume) return base;
      // 仅在已知 kimi 原生 session id 时精确 resume；否则起新会话（同 codex 策略，
      // 不用 --continue 以免多话题共用 workingDir 时串台）。
      if (resumeSessionId) return ['--resume', resumeSessionId, ...base];
      return base;
    },

    buildResumeCommand({ cliSessionId }) {
      // kimi --resume 需要 kimi 自己的 uuid；v1 尚未回填 cliSessionId，
      // 故通常返回 null（卡片回落到静态提示）。
      if (!cliSessionId) return null;
      return `kimi --resume ${cliSessionId}`;
    },

    async writeInput(pty: PtyHandle, content: string) {
      // prompt_toolkit REPL 默认开 bracketed paste：用 tmux load-buffer +
      // paste-buffer -d -p 把整段内容作为一次粘贴送入（嵌入的 \n 保留为内容、
      // 不触发逐行提交），延迟后再补一个 Enter 作为明确提交。
      // 非 tmux 裸 PTY 回落：自行包裹 \e[200~...\e[201~ 标记。
      const trySendEnter = (): boolean => {
        try {
          if (pty.sendSpecialKeys) pty.sendSpecialKeys('Enter');
          else pty.write('\r');
          return true;
        } catch {
          return false;
        }
      };

      try {
        if (pty.pasteText) {
          pty.pasteText(content);
        } else {
          pty.write('\x1b[200~' + content + '\x1b[201~');
        }
      } catch {
        return { submitted: false };
      }
      await delay(500);
      trySendEnter();
    },

    completionPattern: undefined,
    readyPattern: undefined,        // 候选 ` > `，登录实测后再决定是否收紧
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: false,               // 实测：prompt_toolkit 行内 REPL，不进 alt screen
    // kimi 默认会发现并合并 ~/.kimi/skills（brand 目录，不污染其它工具）。
    skillsDir: '~/.kimi/skills',
  };
}

export const create = createKimiAdapter;
