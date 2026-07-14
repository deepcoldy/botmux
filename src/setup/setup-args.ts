/**
 * `botmux setup <list|add|edit|remove>` 非 TUI（脚本化）模式：argv 解析 + 纯映射。
 *
 * 动机：给 coding agent / 脚本一个**字段级**的稳定接口。以前脚本化 setup 只能
 * 对交互问答「管道喂数字」，TUI 问题序列一变（比如新增一问）答案就静默错位；
 * flag 形式不依赖问题顺序，天然稳定。
 *
 * 本模块保持纯函数（不碰 fs / 网络 / process），可单测；目录存在性校验、
 * 凭证校验（tenant_access_token）、bots.json 读写等副作用留在 cli.ts 执行层。
 */
import {
  applyBotConfigEdits,
  assertOwnerWhenChatGroups,
  hasOwnerEntry,
  type BotConfigEditInput,
} from './bot-config-editor.js';
import { CLI_SELECT_OPTIONS, resolveCliSelection } from './cli-selection.js';

/** add / edit 共用的 bot 字段 flag（原始字符串，'-' 表示清空，语义同 TUI 编辑）。 */
export interface SetupBotFlags {
  name?: string;
  /** 仅 add --create-app：飞书开放平台应用名称；留空由执行层生成 botmux-N。 */
  appName?: string;
  appId?: string;
  appSecret?: string;
  /** CLI 选择键：cliId 或网关键（aiden-x-claude / ttadk-x-codex …），见 CLI_SELECT_OPTIONS。 */
  cli?: string;
  cliPath?: string;
  wrapperCli?: string;
  model?: string;
  backend?: string;
  /** 仓库选择卡片的扫描根目录（逗号分隔多个）。 */
  workingDir?: string;
  /** 固定默认目录：新话题直接在此目录启动、不弹仓库选择卡片；'-' 清空回弹卡模式。 */
  defaultWorkingDir?: string;
  allowedUsers?: string;
  allowedChatGroups?: string;
  showInTeam?: string;
  /** 仅 add：feishu | lark。 */
  brand?: string;
}

export type SetupCommand =
  | { action: 'help' }
  | { action: 'list'; json: boolean }
  | { action: 'add'; json: boolean; createApp: boolean; compatibilityMode: boolean; switchAccount: boolean; openPlatformAuto: boolean; flags: SetupBotFlags }
  | { action: 'edit'; json: boolean; selector: string; flags: SetupBotFlags }
  | { action: 'remove'; json: boolean; selector: string; yes: boolean };

/**
 * `botmux setup` 后面第一个参数是否触发脚本化模式：任何**非 flag** 首参数都算
 * （未知子命令由 parseSetupCommand 报错，而不是掉进交互 TUI 把脚本挂住）。
 * 空参数 / 纯 flag（如 --no-open-platform-auto）仍走原交互 TUI，保持向后兼容。
 */
export function isScriptedSetupInvocation(argv: string[]): boolean {
  const first = argv[0];
  if (first === undefined) return false;
  if (first === '--help' || first === '-h') return true;
  return !first.startsWith('-');
}

const BOT_FIELD_FLAGS: Record<string, keyof SetupBotFlags> = {
  '--name': 'name',
  '--app-name': 'appName',
  '--app-id': 'appId',
  '--app-secret': 'appSecret',
  '--cli': 'cli',
  '--cli-path': 'cliPath',
  '--wrapper-cli': 'wrapperCli',
  '--model': 'model',
  '--backend': 'backend',
  '--working-dir': 'workingDir',
  '--default-working-dir': 'defaultWorkingDir',
  '--allowed-users': 'allowedUsers',
  '--allowed-chat-groups': 'allowedChatGroups',
  '--show-in-team': 'showInTeam',
  '--brand': 'brand',
};

export const SETUP_CLI_USAGE = `botmux setup — 脚本化（非 TUI）用法

  botmux setup list [--json]
      列出已配置机器人（--json 输出完整字段，secret 脱敏）。

  botmux setup add --create-app --allowed-users <owner> [--app-name <name>] [选项]
      首次扫码创建飞书应用；后续有效登录态下确认账号/企业后免扫码添加。
      --app-name 留空自动使用 botmux-N；更换账号用 --switch-account。
      默认继续完成权限、长连接事件、redirect 与发版；可用
      --no-open-platform-auto 跳过后半段自动配置。

  botmux setup add --create-app --compatibility-mode --allowed-users <owner> [选项]
      显式使用官方 SDK 兼容模式，可能需要额外扫码。兼容模式不支持
      --app-name，应用名称由平台决定。

  botmux setup add --app-id <cli_xxx> --app-secret <secret> --allowed-users <owner> [选项]
      使用已有凭证添加机器人。必填：--app-id / --app-secret / --allowed-users。
      两种 add 方式都要求至少一个完整邮箱、union_id on_xxx 或 open_id ou_xxx
      作为 owner，写盘前会用凭证换 tenant_access_token 校验；失败不写盘。

  botmux setup edit <进程名|AppID> [字段选项...]
      按字段修改机器人（如 botmux setup edit botmux-0 --cli codex）。
      至少给一个字段选项；值传 - 表示清空该字段。

  botmux setup remove <进程名|AppID> --yes
      删除机器人（非交互删除必须显式 --yes 确认）。

字段选项（add / edit 通用；edit 中未给出的字段保持不变）：
  --name <n>                 botmux status 显示名（进程名后缀）
  --app-name <n>             新建的飞书应用名称（仅 add --create-app）
  --app-id <cli_xxx>         飞书应用 App ID（edit 时改绑另一个应用）
  --app-secret <secret>      App Secret
  --cli <key>                CLI 适配器：cliId 或网关键（claude-code / codex /
                             aiden-x-claude / ttadk-x-codex …）
  --cli-path <path>          CLI 可执行文件路径覆盖
  --wrapper-cli <prefix>     通用启动前缀（如 "aiden x claude"），覆盖 --cli 推导值
  --model <m>                CLI 模型名
  --backend <b>              会话后端 pty | tmux | herdr | zellij
                             traex + herdr 插件安装需在 Dashboard Settings 中显式开启并填写可信 source/ref
  --working-dir <dirs>       仓库选择卡片的扫描根目录（逗号分隔多个）
  --default-working-dir <d>  固定默认目录：新话题直接在此目录启动、不弹仓库
                             选择卡片；传 - 清空、回到弹卡模式
  --allowed-users <a,b>      管理员名单（完整邮箱 / on_xxx / ou_xxx，逗号分隔）
  --allowed-chat-groups <g>  可对话群 chat_id（oc_xxx，逗号分隔）
  --show-in-team <bool>      平台团队页是否展示（默认 true）
  --brand <feishu|lark>      租户类型（仅 add）

通用选项：
  --json                     输出机器可读 JSON（含 ok / error 字段）
  --create-app               add 时扫码创建应用，不再要求 --app-id/--app-secret
  --compatibility-mode       显式使用 SDK 兼容模式（可能需要额外扫码）
  --switch-account           不复用缓存，重新扫码并覆盖本机飞书登录态
  --open-platform-auto       add 成功后执行开放平台自动配置（默认跳过；
                             --create-app 时默认开启）
  --no-open-platform-auto    跳过开放平台权限/发版自动配置
`;

function parseBotFieldFlags(
  tokens: string[],
  opts: { allowFields: boolean; action: string },
): { flags: SetupBotFlags; json: boolean; yes: boolean; createApp: boolean; compatibilityMode: boolean; switchAccount: boolean; openPlatformAuto: boolean; openPlatformAutoSpecified: boolean; positional: string[] } {
  const flags: SetupBotFlags = {};
  const positional: string[] = [];
  let json = false;
  let yes = false;
  let createApp = false;
  let compatibilityMode = false;
  let switchAccount = false;
  let openPlatformAuto = false;
  let openPlatformAutoSpecified = false;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--json') { json = true; continue; }
    if (token === '--yes' || token === '-y') { yes = true; continue; }
    if (token === '--create-app') { createApp = true; continue; }
    if (token === '--compatibility-mode') { compatibilityMode = true; continue; }
    if (token === '--switch-account') { switchAccount = true; continue; }
    if (token === '--open-platform-auto') { openPlatformAuto = true; openPlatformAutoSpecified = true; continue; }
    if (token === '--no-open-platform-auto') { openPlatformAuto = false; openPlatformAutoSpecified = true; continue; }

    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const flag = eq >= 0 ? token.slice(0, eq) : token;
      const field = BOT_FIELD_FLAGS[flag];
      if (!field) {
        throw new Error(`未知参数 ${flag}。查看用法：botmux setup help`);
      }
      if (!opts.allowFields) {
        throw new Error(`${opts.action} 不接受字段参数 ${flag}。查看用法：botmux setup help`);
      }
      let value: string;
      if (eq >= 0) {
        value = token.slice(eq + 1);
      } else {
        const next = tokens[i + 1];
        // '-' 是合法的清空值；以 '--' 开头的下一个 token 视为漏填了取值。
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`${flag} 缺少取值。查看用法：botmux setup help`);
        }
        value = next;
        i++;
      }
      flags[field] = value;
      continue;
    }
    positional.push(token);
  }
  return { flags, json, yes, createApp, compatibilityMode, switchAccount, openPlatformAuto, openPlatformAutoSpecified, positional };
}

/** 解析 `botmux setup` 的脚本化子命令 argv。非法输入抛 Error（message 面向用户）。 */
export function parseSetupCommand(argv: string[]): SetupCommand {
  const [action, ...rest] = argv;
  if (action === 'help' || action === '--help' || action === '-h') return { action: 'help' };

  if (action === 'list') {
    const { json, switchAccount, positional } = parseBotFieldFlags(rest, { allowFields: false, action: 'list' });
    if (switchAccount) throw new Error('--switch-account 仅适用于 add --create-app。');
    if (positional.length > 0) throw new Error(`list 不接受多余参数: ${positional.join(' ')}`);
    return { action: 'list', json };
  }

  if (action === 'add') {
    const { flags, json, createApp, compatibilityMode, switchAccount, openPlatformAuto, openPlatformAutoSpecified, positional } = parseBotFieldFlags(rest, { allowFields: true, action: 'add' });
    if (positional.length > 0) throw new Error(`add 不接受位置参数: ${positional.join(' ')}（字段一律用 --flag 形式）`);
    if (createApp && (flags.appId?.trim() || flags.appSecret?.trim())) {
      throw new Error('--create-app 不能与 --app-id/--app-secret 同时使用。');
    }
    if (!createApp && flags.appName !== undefined) {
      throw new Error('--app-name 必须与 add --create-app 一起使用。');
    }
    if (compatibilityMode && !createApp) {
      throw new Error('--compatibility-mode 必须与 add --create-app 一起使用。');
    }
    if (switchAccount && !createApp) {
      throw new Error('--switch-account 必须与 add --create-app 一起使用。');
    }
    if (switchAccount && compatibilityMode) {
      throw new Error('--switch-account 不适用于 SDK 兼容模式。');
    }
    if (compatibilityMode && flags.appName?.trim()) {
      throw new Error('兼容模式不支持 --app-name；请移除该参数，应用名称将由平台决定。');
    }
    return {
      action: 'add',
      json,
      createApp,
      compatibilityMode,
      switchAccount,
      openPlatformAuto: openPlatformAutoSpecified ? openPlatformAuto : createApp,
      flags,
    };
  }

  if (action === 'edit') {
    const { flags, json, switchAccount, positional } = parseBotFieldFlags(rest, { allowFields: true, action: 'edit' });
    if (switchAccount) throw new Error('--switch-account 仅适用于 add --create-app。');
    if (positional.length === 0) throw new Error('edit 需要指定机器人（进程名 botmux-N 或 AppID）。');
    if (positional.length > 1) throw new Error(`edit 只接受一个机器人标识: ${positional.join(' ')}`);
    return { action: 'edit', json, selector: positional[0], flags };
  }

  if (action === 'remove') {
    const { json, yes, switchAccount, positional } = parseBotFieldFlags(rest, { allowFields: false, action: 'remove' });
    if (switchAccount) throw new Error('--switch-account 仅适用于 add --create-app。');
    if (positional.length === 0) throw new Error('remove 需要指定机器人（进程名 botmux-N 或 AppID）。');
    if (positional.length > 1) throw new Error(`remove 只接受一个机器人标识: ${positional.join(' ')}`);
    return { action: 'remove', json, selector: positional[0], yes };
  }

  throw new Error(`未知 setup 子命令 "${action}"。查看用法：botmux setup help`);
}

/**
 * add flags → 可落盘 bot 对象（纯映射，不做目录存在性 / 凭证校验）。
 * 必填缺失、CLI 选择键非法、owner 缺失等一律抛 Error。
 */
export function buildBotFromAddFlags(flags: SetupBotFlags): Record<string, any> {
  const missing: string[] = [];
  if (!flags.appId?.trim()) missing.push('--app-id');
  if (!flags.appSecret?.trim()) missing.push('--app-secret');
  if (!flags.allowedUsers?.trim()) missing.push('--allowed-users');
  if (missing.length > 0) throw new Error(`add 缺少必填参数: ${missing.join(' ')}`);

  const brand = (flags.brand ?? 'feishu').trim().toLowerCase();
  if (brand !== 'feishu' && brand !== 'lark') {
    throw new Error(`--brand 必须是 feishu 或 lark: ${flags.brand}`);
  }

  const sel = resolveCliSelection((flags.cli ?? 'claude-code').trim());
  const base: Record<string, any> = {
    larkAppId: flags.appId!.trim(),
    larkAppSecret: flags.appSecret!.trim(),
    cliId: sel.cliId,
    ...(sel.wrapperCli ? { wrapperCli: sel.wrapperCli } : {}),
    // 与 TUI 同口径：feishu 不落 brand 字段，bots.json 保持干净。
    ...(brand === 'lark' ? { brand: 'lark' } : {}),
  };

  const input: BotConfigEditInput = {
    name: flags.name,
    cliPathOverride: flags.cliPath,
    model: flags.model,
    backendType: flags.backend,
    // 固定默认目录模式（只给 --default-working-dir）不强写 workingDir，
    // 扫描根回退默认 ~；其余情况与 TUI 一致，总是落 workingDir（留空 → '~'）。
    workingDir: flags.workingDir ?? (flags.defaultWorkingDir ? undefined : '~'),
    defaultWorkingDir: flags.defaultWorkingDir,
    allowedUsers: flags.allowedUsers,
    allowedChatGroups: flags.allowedChatGroups,
    showInTeam: flags.showInTeam,
    // 显式 --wrapper-cli 覆盖 --cli 推导出的前缀（undefined 时不动 base 里的值）。
    wrapperCli: flags.wrapperCli,
  };
  const bot = applyBotConfigEdits(base, input);
  if (!hasOwnerEntry(bot.allowedUsers)) {
    throw new Error('--allowed-users 至少需要一个完整邮箱、union_id（on_xxx）或 open_id（ou_xxx）作为 owner。');
  }
  assertOwnerWhenChatGroups(bot);
  return bot;
}

/**
 * edit flags → BotConfigEditInput（纯映射）。--cli 走 resolveCliSelection：
 * 选普通 CLI 会清掉旧 wrapperCli（与 TUI 一致），显式 --wrapper-cli 再覆盖。
 */
export function editInputFromFlags(flags: SetupBotFlags): BotConfigEditInput {
  if (flags.appName !== undefined) {
    throw new Error('--app-name 仅与 add --create-app 一起使用。');
  }
  if (flags.brand !== undefined) {
    throw new Error('--brand 仅在 add 时可指定（brand 绑定租户域名，换租户请 remove 后重新 add）。');
  }
  const input: BotConfigEditInput = {};
  if (flags.name !== undefined) input.name = flags.name;
  if (flags.appId !== undefined) input.larkAppId = flags.appId;
  if (flags.appSecret !== undefined) input.larkAppSecret = flags.appSecret;
  if (flags.cli !== undefined) {
    const sel = resolveCliSelection(flags.cli.trim());
    input.cliChoice = sel.cliId;
    input.wrapperCli = sel.wrapperCli ?? null;
  }
  if (flags.wrapperCli !== undefined) input.wrapperCli = flags.wrapperCli;
  if (flags.cliPath !== undefined) input.cliPathOverride = flags.cliPath;
  if (flags.model !== undefined) input.model = flags.model;
  if (flags.backend !== undefined) input.backendType = flags.backend;
  if (flags.workingDir !== undefined) input.workingDir = flags.workingDir;
  if (flags.defaultWorkingDir !== undefined) input.defaultWorkingDir = flags.defaultWorkingDir;
  if (flags.allowedUsers !== undefined) input.allowedUsers = flags.allowedUsers;
  if (flags.allowedChatGroups !== undefined) input.allowedChatGroups = flags.allowedChatGroups;
  if (flags.showInTeam !== undefined) input.showInTeam = flags.showInTeam;
  return input;
}

/** 合法 --cli 取值（报错提示用）。 */
export function cliSelectionKeys(): string[] {
  return CLI_SELECT_OPTIONS.map(o => o.key);
}

/** list --json 输出前的 secret 脱敏（CLI 输出可能被贴进聊天/日志）。 */
export function maskAppSecret(secret: unknown): string {
  if (typeof secret !== 'string' || !secret) return '';
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}
