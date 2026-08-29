import { resolveCommand } from './registry.js';
import { BOTMUX_SHELL_HINTS } from './shared-hints.js';
import type { CliAdapter, PtyHandle, ResumableSession } from './types.js';
import {
  detectOpenCodeSubmit,
  isOpenCodeSessionBusy,
  isOpenCodeSessionId,
  latestOpenCodeSessionForBotmuxSession,
  listOpenCodeResumableSessions,
  sessionRowExists,
  snapPartBaseline,
  withDb,
} from './opencode.js';

import { delay } from '../../utils/timing.js';

/**
 * OpenCode 2.0（opencode2）适配器。OpenCode 2 是 1.x 的下一个主版本（beta，随
 * `@opencode-ai/cli@next` 发布，二进制名 `opencode2`），与 V1 可并行安装。
 *
 * 与 V1 的关键差异（均在 next-17135 实测 / 源码确认）：
 *   - **会话存储是 V2 新表结构**：opencode2 写同一个全局
 *     `~/.local/share/opencode/opencode.db`，但会话/消息落在 `session_v2` /
 *     `session_message` 表（V1 的 session/message/part 表已冻结）。resume 探测、
 *     submit 验证、cliSessionId 捕获、/adopt 导入复用 opencode.ts 导出的 SQLite
 *     实现时统一走 v2 表空间。
 *   - **TUI 顶层命令没有 `--model` 标志**（只有 `run` 子命令有）。传了会被当作
 *     unknown flag 直接打印帮助退出 —— 模型只能通过 opencode 配置/UI 设置，
 *     因此 buildArgs 不注入 model，modelChoices 也留空（setup 跳过模型询问）。
 *   - **`--prompt` 不自动提交**：next-17135 实测把 prompt 填进 composer 后不会
 *     submit（next-17082 上 -s resume 的自动提交行为已回归）。因此首条消息不走
 *     args 注入，改走输入队列 paste+Enter（worker 在 ready 后投递，经 DB 验证），
 *     fresh 与 resume 路径一致 —— 不设 passesInitialPromptViaArgs。
 *   - **插件 API 是全新 V2 契约**（default export `{ id, setup }`，事件走
 *     `ctx.event.subscribe()` 异步迭代流），V1 插件格式不兼容。ask-hook 插件由
 *     hook-installer 的 'opencode2-plugin' 格式写入 `~/.config/opencode/plugins/`
 *     （V2 的全局插件发现目录，复数），回复走新端点
 *     `POST /api/session/{sessionID}/question/{requestID}/reply` + 注册文件发现的
 *     Basic auth + `x-opencode-directory` 头（多 worktree 路由）。
 *   - **TUI 配置迁移到 `~/.config/opencode/cli.json`**（auto 迁移自 tui.json），
 *     skills 仍从 `~/.config/opencode/skills` 全局发现（V2 文档确认）。
 */

const OPENCODE_PASTE_THRESHOLD = 150;

export function createOpenCode2Adapter(pathOverride?: string): CliAdapter {
  const rawBin = pathOverride ?? 'opencode2';
  let cachedBin: string | undefined;
  return {
    id: 'opencode2',
    // 与 opencode 共用同一数据根：opencode2 的全局 SQLite 库（opencode.db, WAL）
    // 就在这个目录。沙盒 deny-by-default 下必须整目录真实 bind，否则 DB 不存在、
    // SQLite fcntl 锁拿不到（与 codex/opencode 同款失败模式）。
    authPaths: ['~/.local/share/opencode'],
    // ask-hook 插件文件在全局插件发现目录；沙盒里按只读 bind 暴露，让服务端能加载
    // （botmux 在 spawn 前已把文件写到真实宿主路径）。
    sandboxReadonlyPaths: () => ['~/.config/opencode/plugins'],
    get resolvedBin(): string { return (cachedBin ??= resolveCommand(rawBin)); },

    buildArgs({ sessionId, resume, resumeSessionId }) {
      const args: string[] = [];
      // 注意：没有 --model —— V2 TUI 顶层不接受该标志（传了直接打帮助退出）。
      const openCodeSessionId = resume
        ? (isOpenCodeSessionId(resumeSessionId) ? resumeSessionId : latestOpenCodeSessionForBotmuxSession(sessionId, 'v2'))
        : undefined;
      if (openCodeSessionId) {
        args.push('--session', openCodeSessionId);
      }
      // 不注入 --prompt：next-17135 实测 --prompt 只填 composer 不自动提交（不建
      // 会话不写消息）。首条消息由 worker 走输入队列经 writeInput paste+Enter
      // 投递（passesInitialPromptViaArgs 不置位），fresh 与 resume 路径一致。
      return args;
    },

    // 首条消息走输入队列（ready 后 flush + DB 验证），不依赖 CLI 的 args 自动提交。
    passesInitialPromptViaArgs: false,

    buildResumeCommand({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId) ? cliSessionId : latestOpenCodeSessionForBotmuxSession(sessionId, 'v2');
      if (!sid) return null;
      return `opencode2 -s ${sid}`;
    },

    /** Resume 目标预检：id 不在 session_v2 表 → false
     *  （worker 落回全新会话并提示），避免 `Session not found` exit 1 被放大成
     *  daemon 自动重启 crash-loop。DB 读不了 → undefined，交给 worker 二级护栏。 */
    checkResumeTargetExists({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId) ? cliSessionId : latestOpenCodeSessionForBotmuxSession(sessionId, 'v2');
      if (!sid) {
        return withDb(() => true) === null ? undefined : false;
      }
      const exists = sessionRowExists(sid, 'v2');
      return exists === null ? undefined : exists;
    },

    /** Import path（/adopt 第二过滤器）：复用 opencode 的全局会话查询（V2 表空间）。 */
    listResumableSessions(opts: { limit: number; exclude?: ReadonlySet<string> }): Promise<ResumableSession[]> {
      return Promise.resolve(listOpenCodeResumableSessions(opts, 'v2'));
    },

    async writeInput(pty: PtyHandle, content: string) {
      const isSlashCommand = content.startsWith('/');
      const baseline = isSlashCommand ? null : snapPartBaseline('v2');

      try {
        if (pty.sendText && pty.sendSpecialKeys) {
          if (!isSlashCommand && pty.pasteText && (content.length > OPENCODE_PASTE_THRESHOLD || content.includes('\n'))) {
            pty.pasteText(content);
          } else {
            pty.sendText(content);
          }
          await delay(200);
          pty.sendSpecialKeys('Enter');
        } else {
          pty.write(content);
          await delay(1000);
          pty.write('\r');
        }
      } catch {
        return { submitted: false };
      }

      if (baseline === null) return undefined;

      const result = await detectOpenCodeSubmit(pty, baseline, content, delay, 'v2');
      if (result.submitted) {
        return result.cliSessionId
          ? { submitted: true, cliSessionId: result.cliSessionId }
          : { submitted: true };
      }
      return { submitted: false, recheck: result.recheck };
    },

    completionPattern: undefined,
    readyPattern: undefined,
    busyPattern: undefined,
    isSessionBusy({ sessionId, cliSessionId }) {
      const sid = isOpenCodeSessionId(cliSessionId)
        ? cliSessionId
        : latestOpenCodeSessionForBotmuxSession(sessionId, 'v2');
      if (!sid) return false;
      return isOpenCodeSessionBusy(sid, 'v2');
    },
    systemHints: BOTMUX_SHELL_HINTS,
    altScreen: true,                // V2 TUI 仍渲染在 alternate screen buffer（实测 \x1b[?1049h）
    readOnlyRemoteScroll: true,
    skillsDir: '~/.config/opencode/skills',
    // botmux ask-hook：V2 插件（新插件 API），写入 V2 全局插件发现目录。
    // ⚠️ beta 已知上游问题（next-17082）：HOME 是符号链接（如 /home→/data00/home）的
    // 主机上，V2 服务端无法 import 全局插件目录里"新写入"的插件文件（loader 的
    // freshSpecifier 把 realpath+?mtime 拼成普通路径 specifier 后 Bun 解析失败；
    // 项目级 .opencode/plugins/ 不受影响）。表现为日志 "Cannot find module ...?mtime=..."，
    // 该主机上 ask 走原生 picker 兜底（web 终端仍可作答），其余能力不受影响。
    hookInstall: {
      configPath: '~/.config/opencode/plugins/botmux-ask.js',
      format: 'opencode2-plugin',
    },
    asksViaHook: true,
    // V2 TUI 顶层无 --model，模型由 opencode 配置/UI 决定 —— modelChoices 留空，
    // setup 为此 CLI 跳过模型询问（与「模型走配置文件管理」的 CLI 同一语义）。
  };
}

export const create = createOpenCode2Adapter;
