/**
 * hook-installer.ts
 *
 * 把 botmux 的 askUserQuestion hook 写入各 CLI 的配置文件。
 * 幂等：写前比对内容，相同则跳过；展开 ~ 路径；出错只 warn 不抛。
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';
import { hookCommandParts } from './hook-command.js';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface HookInstallConfig {
  readonly configPath: string;
  readonly format: 'claude-settings' | 'opencode-plugin';
  /** 可选（claude-settings）：同时把 SessionStart 就绪 hook 命令写进全局 settings.json。
   *  见 adapters/cli/types.ts 的同名字段说明（为 wrapperCli=aiden x claude 这类剥 --settings
   *  的启动器提供就绪信号）。 */
  readonly sessionStartCommand?: string;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 展开路径中的 ~ 为当前用户 home 目录。 */
function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

/** 读 JSON 文件，失败返回 null。 */
function readJsonFile<T>(filePath: string): T | null {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 幂等写文件：若内容与现有相同则跳过；自动创建目录。 */
function writeIfChanged(filePath: string, content: string): boolean {
  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf-8');
      if (existing === content) return false; // 内容相同，无需写入
    }
    mkdirSync(dirname(filePath), { recursive: true });
    // 原子写：目标是 ~/.claude/settings.json 这类被 CLI 并发读写的热配置，
    // 裸写半截会让并发读者拿到坏 JSON 再整文件覆写回来（cjadk 事故同类）。
    atomicWriteFileSync(filePath, content);
    return true;
  } catch (err: any) {
    throw new Error(`写入 ${filePath} 失败：${err.message}`);
  }
}

// ─── Claude settings.json 格式 ───────────────────────────────────────────────

interface ClaudeHookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHookGroup[]>;
  [key: string]: unknown;
}

/**
 * 从完整 hookCommand 中提取 `hook <cliId>` 尾签名。
 * hookCommand 形如：`"<node>" "<...dist/cli.js>" hook claude-code`，
 * 尾部 `hook <cliId>` 不随 node / cli.js 安装路径变化。
 */
function botmuxHookSuffix(hookCommand: string): string {
  const idx = hookCommand.lastIndexOf(' hook ');
  return idx === -1 ? hookCommand : hookCommand.slice(idx + 1); // "hook <cliId>"
}

/**
 * 判断某个 hook group 是否是 botmux ask hook（用于幂等替换）。
 *
 * 不能只按命令字符串完全相等比对：同一台机器上 dev 源码 checkout 与 npm global
 * 安装的 cli.js 绝对路径不同，命令字符串就不同，会导致两条 botmux hook 同时残留、
 * 同一次 AskUserQuestion 触发两次 → 飞书发出两张卡。
 * 因此结构化识别：命令引用了 botmux 的 `cli.js` 且尾部是相同的 `hook <cliId>` 签名，
 * 即视为 botmux hook，无论它指向哪个安装路径。
 */
function isBotmuxAskHookGroup(group: ClaudeHookGroup, hookCommand: string): boolean {
  const suffix = botmuxHookSuffix(hookCommand); // e.g. "hook claude-code"
  return group.hooks.some(
    (e) =>
      e.type === 'command' &&
      (e.command === hookCommand ||
        (e.command.includes('cli.js') && e.command.trimEnd().endsWith(suffix))),
  );
}

function removeBotmuxAskHookGroups(
  hooks: Record<string, ClaudeHookGroup[]>,
  eventName: string,
  hookCommand: string,
): void {
  const existing = hooks[eventName] ?? [];
  const filtered = existing.filter((g) => !isBotmuxAskHookGroup(g, hookCommand));
  if (filtered.length === 0) {
    delete hooks[eventName];
  } else {
    hooks[eventName] = filtered;
  }
}

/**
 * 判断某 hook group 是否是 botmux SessionStart 就绪 hook（用于幂等替换）。
 * 同 ask hook：结构化识别（命令引用 botmux 的 cli.js 且尾部是 `session-ready`），
 * 不按完整字符串比对——dev checkout 与 npm global 的 cli.js 绝对路径不同。
 */
function isBotmuxReadyHookGroup(group: ClaudeHookGroup): boolean {
  return group.hooks.some(
    (e) =>
      e.type === 'command' &&
      e.command.includes('cli.js') &&
      e.command.trimEnd().endsWith('session-ready'),
  );
}

function removeBotmuxReadyHookGroups(hooks: Record<string, ClaudeHookGroup[]>, eventName: string): void {
  const existing = hooks[eventName] ?? [];
  const filtered = existing.filter((g) => !isBotmuxReadyHookGroup(g));
  if (filtered.length === 0) delete hooks[eventName];
  else hooks[eventName] = filtered;
}

/**
 * 向 Claude settings.json 的 hooks.PreToolUse 合并 botmux ask hook entry。
 * AskUserQuestion 在 bypassPermissions 模式下不会经过 PermissionRequest，
 * 但 PreToolUse 仍会在工具执行前触发，因此这里必须挂 PreToolUse。
 * 保留其他事件和 entry，不破坏无关配置。
 *
 * 若提供 sessionStartCommand，再把 SessionStart「真就绪」hook 也写进全局 settings.json
 * （为 wrapperCli=`aiden x claude` 这类剥 --settings 的启动器提供就绪信号；原生 claude
 * 会同时收到进程级 --settings 那份，二者幂等无害）。
 */
function installClaudeSettings(configPath: string, hookCommand: string, sessionStartCommand?: string): void {
  const settings: ClaudeSettings = readJsonFile<ClaudeSettings>(configPath) ?? {};
  const existingHooks = settings.hooks ?? {};

  // 构造 botmux PreToolUse hook group（只拦截 AskUserQuestion）
  const newEntry: ClaudeHookEntry = { type: 'command', command: hookCommand, timeout: 86400 };
  const newGroup: ClaudeHookGroup = { matcher: 'AskUserQuestion', hooks: [newEntry] };

  // 过滤掉旧的 botmux ask hook group（幂等 + 从 PermissionRequest 迁移到 PreToolUse）
  removeBotmuxAskHookGroups(existingHooks, 'PermissionRequest', hookCommand);
  removeBotmuxAskHookGroups(existingHooks, 'PreToolUse', hookCommand);
  existingHooks['PreToolUse'] = [...(existingHooks['PreToolUse'] ?? []), newGroup];

  // SessionStart 就绪 hook（幂等替换旧的 botmux 条目）
  if (sessionStartCommand) {
    removeBotmuxReadyHookGroups(existingHooks, 'SessionStart');
    existingHooks['SessionStart'] = [
      ...(existingHooks['SessionStart'] ?? []),
      { hooks: [{ type: 'command', command: sessionStartCommand }] },
    ];
  }

  settings.hooks = existingHooks;
  const content = JSON.stringify(settings, null, 2) + '\n';
  const changed = writeIfChanged(configPath, content);
  if (changed) {
    logger.info(`[hook] 已写入 Claude hook → ${configPath}`);
  } else {
    logger.info(`[hook] Claude hook 已是最新，跳过写入 → ${configPath}`);
  }
}

// ─── OpenCode plugin 格式 ─────────────────────────────────────────────────────

/**
 * 构造 botmux ask 的 OpenCode 插件内容。
 *
 * 机制（已在 OpenCode 1.17.x 实机验证）：
 *   - OpenCode 自带原生 `question` 工具（= Claude AskUserQuestion 等价物），模型会原生
 *     调用，无需我们注入。它被调用时，服务端发布 `question.asked` 事件并阻塞，等客户端
 *     把答案提交到 `/question/{id}/reply`（body `{ answers }`）后才解阻塞、返回给模型。
 *   - OpenCode 插件 API 没有 `question.asked` 这种专用钩子；要拦截只能用通用 `event` 钩子
 *     按 `event.type === 'question.asked'` 过滤（plugin 导出必须是「函数」而非对象）。
 *
 * 事件 payload 形状：
 *   { type:'question.asked', properties:{ id:'que_…', sessionID:'ses_…',
 *     questions:[{ question, header, options:[{label,description}], multiple? }] } }
 *
 * 转发策略：把 questions 规范成 `botmux hook opencode` 认识的 payload 喂给它（复用现有
 * 飞书问答链路：daemon /api/asks → 飞书卡片 → 用户作答 → directive），拿到 stdout 里的
 * `{ answers }` 后回传给 OpenCode 解阻塞。
 *   - **回传必须走 OpenCode 注入给插件的 client（`client._client`）**，不能用裸 fetch：
 *     OpenCode 是「单 server 多 worktree 实例」模型，client 自带 `x-opencode-directory`
 *     头把 reply 路由到发起 question 的那个实例，且其传输在 daemon 里实际可达
 *     （裸 fetch 到 `localhost:4096` 在 daemon 里连不上 + 缺 directory 头 → 永远卡 picker）。
 *   - **异步**作答：飞书侧作答可能耗时很久（默认上限 1h），绝不能用 spawnSync 同步阻塞
 *     OpenCode 的单线程事件总线（会冻结整个 TUI）。改用异步 spawn + fire-and-forget。
 *   - stdout 为空（passthrough：daemon 不可达 / 超时 / 非 botmux 会话）→ 不 reply，把问题
 *     留给 OpenCode 原生 picker（botmux web 终端里仍可人工作答）。
 */
function buildOpenCodePlugin(parts: { cmd: string; args: string[] }): string {
  // 用 argv 形式嵌入（不拼 shell 字符串、不 split）：含空格/引号的路径也不会被拆坏。
  const cmdLit = JSON.stringify(parts.cmd);
  const argsLit = JSON.stringify(parts.args);
  return `// botmux-ask opencode plugin
// 监听 OpenCode 原生 \`question\` 工具触发的 \`question.asked\` 事件，转发到
// \`botmux hook opencode\`（飞书问答），再把答案 POST 回 OpenCode 解阻塞。
import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CMD = ${cmdLit};
const ARGS = ${argsLit};

// 诊断日志：默认关闭，设 BOTMUX_OPENCODE_ASK_DEBUG=1 后每步落盘到
// ~/.botmux/opencode-ask-debug.log，用于排查 ask 链路（事件→转发→reply）。
const DBG_ON = !!process.env.BOTMUX_OPENCODE_ASK_DEBUG;
const DBG = join(homedir(), ".botmux", "opencode-ask-debug.log");
function dbg(m) {
  if (!DBG_ON) return;
  try { appendFileSync(DBG, new Date().toISOString() + " " + m + "\\n"); } catch {}
}

// 异步 spawn \`botmux hook opencode\`：stdin 喂 payload，收集 stdout。
// 任何失败都 resolve("")（= passthrough 放行）。child 自带超时（hook 客户端按
// BOTMUX_ASK_TIMEOUT_MS 自限），这里再加 25h 兜底 kill 防僵尸（unref 不拖住事件循环）。
function askBotmux(payload) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(CMD, ARGS, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return done("");
    }
    const backstop = setTimeout(() => { try { child.kill(); } catch {} done(""); }, 90000000);
    if (typeof backstop.unref === "function") backstop.unref();
    child.stdout.on("data", (d) => { out += d.toString("utf-8"); });
    child.on("error", () => { clearTimeout(backstop); done(""); });
    child.on("close", (code) => { clearTimeout(backstop); done(code === 0 ? out : ""); });
    try { child.stdin.write(payload); child.stdin.end(); } catch { clearTimeout(backstop); done(""); }
  });
}

// 把答案回传给 OpenCode 解阻塞。
// 必须走 OpenCode 自带的 client（client._client = 已配置的 hey-api client）——
// 它带着 \`x-opencode-directory\` 头与正确的 baseUrl/传输。OpenCode 用「单 server 多
// worktree 实例」模型，该头用于把 reply 路由到发起 question 的那个实例；裸 fetch 缺这个
// 头会打到错误实例（question 找不到 → 永远卡在 picker）。失败再回落裸 fetch（复制其 headers）。
function safeStr(x) {
  try { return String(JSON.stringify(x)).slice(0, 120); } catch { return String(x); }
}

async function postReply(client, serverUrl, id, answers) {
  const body = { answers };
  // 1) 经 client._client（带 directory 头 + 正确传输）。这是 daemon 多实例下唯一可达的路径：
  //    裸 fetch 到 localhost:4096 在 daemon 里根本连不上（OpenCode 用 interceptor 传输）。
  try {
    const c = client && client._client;
    if (c && typeof c.post === "function") {
      const res = await c.post({ url: "/question/" + id + "/reply", body });
      const st = res && res.response && res.response.status;
      const success = (res && res.data === true) || (st && st >= 200 && st < 300);
      dbg("CLIENT_POST id=" + id + " status=" + st + " data=" + safeStr(res && res.data) + " err=" + safeStr(res && res.error));
      if (success) return true;
    } else {
      dbg("CLIENT_POST_UNAVAILABLE id=" + id);
    }
  } catch (e) { dbg("CLIENT_POST_THREW id=" + id + " err=" + String(e)); }
  // 2) 回落裸 fetch，尽量复制 client 的 headers（含 directory）与 baseUrl
  try {
    let base = String(serverUrl).replace(/\\/+$/, "");
    let headers = { "content-type": "application/json" };
    try {
      const cfg = client && client._client && client._client.getConfig && client._client.getConfig();
      if (cfg) {
        if (cfg.baseUrl) base = String(cfg.baseUrl).replace(/\\/+$/, "");
        if (cfg.headers) headers = Object.assign({}, cfg.headers, { "content-type": "application/json" });
      }
    } catch {}
    const url = base + "/question/" + id + "/reply";
    dbg("FETCH_POST url=" + url + " headers=" + Object.keys(headers).join(","));
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    let txt = ""; try { txt = await r.text(); } catch {}
    dbg("FETCH_POST_RESULT id=" + id + " status=" + r.status + " body=" + txt.slice(0, 150));
    return r.ok;
  } catch (e) { dbg("FETCH_POST_THREW id=" + id + " err=" + String(e)); return false; }
}

export const BotmuxAsk = async ({ client, serverUrl }) => {
  dbg("PLUGIN_LOADED serverUrl=" + serverUrl + " hasClient=" + !!(client && client._client));
  return {
    event: async ({ event }) => {
      if (!event || event.type !== "question.asked") return;
      const props = event.properties || {};
      const id = props.id;
      const questions = props.questions;
      dbg("EVENT question.asked id=" + id + " sessionID=" + props.sessionID + " nQ=" + (Array.isArray(questions) ? questions.length : "?"));
      if (!id || !Array.isArray(questions) || questions.length === 0) { dbg("SKIP missing id/questions"); return; }
      // fire-and-forget：不 await，避免阻塞事件总线（飞书作答可能很久）。
      // 问题在服务端独立阻塞，答案经 reply 回去即可解阻塞。
      (async () => {
        const payload = JSON.stringify({
          hook_event_name: "question.asked",
          question_id: id,
          session_id: props.sessionID,
          tool_input: { questions },
        });
        dbg("SPAWN botmux hook opencode id=" + id);
        const stdout = (await askBotmux(payload)).trim();
        dbg("HOOK_STDOUT id=" + id + " len=" + stdout.length + " body=" + stdout.slice(0, 300));
        if (!stdout) { dbg("PASSTHROUGH empty stdout id=" + id); return; } // passthrough/超时 → 不应答，留给原生 picker
        let directive;
        try { directive = JSON.parse(stdout); } catch (e) { dbg("PARSE_FAIL id=" + id + " err=" + String(e)); return; }
        const answers = directive && directive.answers;
        if (!Array.isArray(answers)) { dbg("NO_ANSWERS id=" + id + " directive=" + JSON.stringify(directive).slice(0, 200)); return; }
        dbg("REPLY id=" + id + " answers=" + JSON.stringify(answers));
        const ok = await postReply(client, serverUrl, id, answers);
        dbg("REPLY_DONE id=" + id + " ok=" + ok);
      })().catch((e) => { dbg("HANDLER_ERR id=" + id + " err=" + String(e)); });
    },
  };
};
`;
}

/**
 * 写入 OpenCode 插件文件。幂等：内容相同则跳过。
 */
function installOpenCodePlugin(configPath: string, parts: { cmd: string; args: string[] }): void {
  const content = buildOpenCodePlugin(parts);
  const changed = writeIfChanged(configPath, content);
  if (changed) {
    logger.info(`[hook] 已写入 OpenCode 插件 → ${configPath}`);
  } else {
    logger.info(`[hook] OpenCode 插件已是最新，跳过写入 → ${configPath}`);
  }
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 幂等地将 botmux ask hook 安装到指定 CLI 的配置文件。
 *
 * @param cliId - CLI 标识符（用于日志）
 * @param hookInstall - adapter 提供的安装描述（configPath + format）
 * @param hookCommand - botmux hook 子命令的完整调用字符串
 *                      例如："/usr/bin/node /path/to/cli.js hook claude-code"
 */
export function installHook(
  cliId: string,
  hookInstall: HookInstallConfig,
  hookCommand: string,
): void {
  try {
    const configPath = expandHome(hookInstall.configPath);
    switch (hookInstall.format) {
      case 'claude-settings':
        installClaudeSettings(configPath, hookCommand, hookInstall.sessionStartCommand);
        break;
      case 'opencode-plugin':
        // OpenCode 插件走 argv parts（异步 spawn），不复用 shell 字符串，避免被 split 拆坏。
        installOpenCodePlugin(configPath, hookCommandParts(cliId));
        break;
      default: {
        // TypeScript exhaustiveness（编译时保障，运行时防御）
        const _exhaustive: never = hookInstall.format;
        logger.warn(`[hook] 未知 format：${_exhaustive}，跳过 ${cliId}`);
      }
    }
  } catch (err: any) {
    logger.warn(`[hook] install failed for ${cliId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
