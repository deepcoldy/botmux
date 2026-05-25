/**
 * hook-installer.ts
 *
 * 把 botmux 的 askUserQuestion hook 写入各 CLI 的配置文件。
 * 幂等：写前比对内容，相同则跳过；展开 ~ 路径；出错只 warn 不抛。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { logger } from '../utils/logger.js';

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface HookInstallConfig {
  readonly configPath: string;
  readonly format: 'claude-settings' | 'opencode-plugin';
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
    writeFileSync(filePath, content, 'utf-8');
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

/** 判断某个 hook group 是否是 botmux ask hook（用于幂等替换）。 */
function isBotmuxAskHookGroup(group: ClaudeHookGroup, hookCommand: string): boolean {
  return group.hooks.some(
    (e) => e.type === 'command' && e.command === hookCommand,
  );
}

/**
 * 向 Claude settings.json 的 hooks.PermissionRequest 合并 botmux ask hook entry。
 * 保留其他事件和 entry，不破坏无关配置。
 */
function installClaudeSettings(configPath: string, hookCommand: string): void {
  const settings: ClaudeSettings = readJsonFile<ClaudeSettings>(configPath) ?? {};
  const existingHooks = settings.hooks ?? {};

  // 构造 botmux PermissionRequest hook group（matcher=* 拦截所有工具，含 AskUserQuestion）
  const newEntry: ClaudeHookEntry = { type: 'command', command: hookCommand, timeout: 86400 };
  const newGroup: ClaudeHookGroup = { matcher: '*', hooks: [newEntry] };

  // 过滤掉旧的 botmux ask hook group（幂等：同 hookCommand 只保留一份）
  const existing = existingHooks['PermissionRequest'] ?? [];
  const filtered = existing.filter((g) => !isBotmuxAskHookGroup(g, hookCommand));
  existingHooks['PermissionRequest'] = [...filtered, newGroup];

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
 * 插件监听 question.asked 事件，将 payload JSON 写入 botmux hook opencode 的 stdin，
 * 读取 stdout 作为回答，返回给 OpenCode。
 *
 * TODO(dogfood): 校验 OpenCode 插件 question.asked API
 * OpenCode 插件 API 目前处于 dogfood 阶段，`question.asked` 钩子形状和返回值约定
 * 需要在真实会话中实测确认（stdin/stdout 格式、同步/异步、返回值结构等）。
 */
function buildOpenCodePlugin(hookCommand: string): string {
  // 把 hookCommand 拆成 [execPath, ...args]，供 spawnSync 调用
  // hookCommand 形如：/path/to/node /path/to/cli.js hook opencode
  const escapedCommand = JSON.stringify(hookCommand);
  return `// botmux-ask opencode plugin
// 将 OpenCode 的 question.asked 事件转发到 botmux hook opencode。
// TODO(dogfood): 校验 OpenCode 插件 question.asked API
import { spawnSync } from "child_process";

export default {
  name: "botmux-ask",

  // question.asked: OpenCode 向用户提问时触发。
  // payload 形状待实测（见 TODO 注释）。
  // 返回值 { answer: string } 或 undefined（undefined = 由 OpenCode 自行处理）。
  "question.asked"(payload) {
    try {
      const input = JSON.stringify(payload);
      const parts = ${escapedCommand}.split(" ");
      const result = spawnSync(parts[0], parts.slice(1), {
        input,
        encoding: "utf-8",
        timeout: 86400000, // 24h，等待用户在飞书回答
      });
      if (result.status === 0 && result.stdout) {
        return JSON.parse(result.stdout.trim());
      }
    } catch {
      // 任何失败都降级放行：返回 undefined 让 OpenCode 回退原生终端提问
    }
    return undefined;
  },
};
`;
}

/**
 * 写入 OpenCode 插件文件。幂等：内容相同则跳过。
 */
function installOpenCodePlugin(configPath: string, hookCommand: string): void {
  const content = buildOpenCodePlugin(hookCommand);
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
        installClaudeSettings(configPath, hookCommand);
        break;
      case 'opencode-plugin':
        installOpenCodePlugin(configPath, hookCommand);
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
