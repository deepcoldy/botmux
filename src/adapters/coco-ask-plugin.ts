/**
 * coco-ask-plugin.ts
 *
 * 把 botmux 的 AskUserQuestion hook 以 **CoCo 插件** 形式安装到 CoCo (Trae CLI)。
 *
 * 为什么是插件而不是写配置文件：CoCo 0.120.x 把 hook 模型迁到了「插件 +
 * marketplace」——老的 traecli.yaml 顶层 `hooks:` 在迁移时被丢弃，现在 hook 要么
 * 内联进 traecli.toml（无 matcher，会对每个 tool 调用都触发，浪费），要么打包进
 * 插件的 hooks.json（**支持 matcher**，可精确只拦 AskUserQuestion）。我们选后者。
 *
 * 插件目录结构（与 CoCo 官方插件一致）：
 *   <pluginDir>/.codex-plugin/plugin.json   —— 清单，hooks 指向 ./hooks.json
 *   <pluginDir>/hooks.json                  —— Claude settings.json 同构：
 *     { hooks: { PreToolUse: [ { matcher:"AskUserQuestion",
 *                                hooks:[ {type:"command", command:<botmux hook coco>, timeout} ] } ] } }
 *
 * 安装走 `coco plugin install <dir> --type local --yes`（幂等：同名插件覆盖；
 * 每个 daemon 生命周期由 ensureCliSkills 调用一次）。这是全局安装（写
 * ~/.trae 的 traecli.toml 信任哈希 + plugins 缓存），所有 CoCo 会话都会装上这条
 * hook——但 hook 客户端在缺 BOTMUX_* env 时直接 passthrough，不影响用户自己跑的
 * CoCo（与 Claude 写全局 settings.json 的安全模型一致）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { hookCommandFor } from './hook-command.js';

/** botmux 生成的 CoCo ask 插件目录（不放进 ~/.trae，安装时由 coco 拷进 plugins 缓存）。 */
const COCO_ASK_PLUGIN_DIR = join(homedir(), '.botmux', 'coco-ask-plugin');

/** 幂等地构建插件目录并 `coco plugin install` 安装。失败只 warn 不抛。 */
export function installCocoAskPlugin(cocoBin: string): void {
  try {
    const hookCommand = hookCommandFor('coco'); // 形如：'"<node>" "<cli.js>" hook coco'
    const manifest = {
      name: 'botmux-ask',
      version: '1.0.0',
      description: 'Route CoCo AskUserQuestion to a Lark selection card (botmux).',
      hooks: './hooks.json',
      interface: {
        displayName: 'botmux ask',
        shortDescription: 'Route AskUserQuestion to Lark',
        category: 'Productivity',
      },
    };
    // 只拦 AskUserQuestion；hook 客户端对其它事件/非 botmux 会话自行 passthrough。
    const hooks = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'AskUserQuestion',
            hooks: [{ type: 'command', command: hookCommand, timeout: 86400 }],
          },
        ],
      },
    };

    mkdirSync(join(COCO_ASK_PLUGIN_DIR, '.codex-plugin'), { recursive: true });
    writeFileSync(
      join(COCO_ASK_PLUGIN_DIR, '.codex-plugin', 'plugin.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf-8',
    );
    writeFileSync(
      join(COCO_ASK_PLUGIN_DIR, 'hooks.json'),
      JSON.stringify(hooks, null, 2) + '\n',
      'utf-8',
    );

    // 幂等安装（--yes 跳过确认）。stdio 忽略，避免污染 daemon 日志；超时兜底。
    execFileSync(cocoBin, ['plugin', 'install', COCO_ASK_PLUGIN_DIR, '--type', 'local', '--yes'], {
      stdio: 'ignore',
      timeout: 60_000,
    });
    logger.info(`[hook] CoCo ask 插件已安装 → ${COCO_ASK_PLUGIN_DIR}`);
  } catch (err) {
    logger.warn(
      `[hook] CoCo ask 插件安装失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
