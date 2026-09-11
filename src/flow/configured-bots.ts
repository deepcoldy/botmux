/**
 * flow 校验「执行 bot 存在」用的 bots.json 轻量读取（设计文档 §6.1「bot 当执行器」）。
 *
 * 只取身份三元组（larkAppId / displayName / cliId），刻意不走 `bot-registry.ts` 的 `loadBotConfigs()`：
 * 那条路会把 Lark SDK、i18n、logger 整套拖进 flow-runner 子进程，而这里只需要「有哪些 bot、叫什么、跑什么 CLI」。
 * 路径与跳过规则与 bot-registry 对齐：`BOTS_CONFIG` env → `<config dir>/bots.json`；核心态
 * （`BOTMUX_CORE_ONLY=1`）只有 env 合成的那一个 bot；activation-* 过程中的条目不算已配置；
 * `cliId` 缺省同 `LEGACY_DEFAULT_CLI_ID`。
 *
 * 读不到（文件缺失 / 沙箱只读隔离拒绝内容读 / JSON 坏 / 顶层不是数组）返回 null，调用方退回只按在线 daemon 校验——
 * 这是「存在性」校验，宁可少校验也不能把一份读坏的名单当成权威去拒绝一个其实在线的 bot。
 */
import { readFileSync } from 'node:fs';
import { resolveBotsConfigFile } from '../core/config-dir.js';

export interface ConfiguredBot {
  larkAppId: string;
  /** bots.json 的 `displayName`（已 trim）；没配就没有。 */
  displayName?: string;
  cliId: string;
}

/** 与 bot-registry 的 `LEGACY_DEFAULT_CLI_ID` 相同；不从那里 import 是为了不把整个 registry 拖进来。 */
const LEGACY_DEFAULT_CLI_ID = 'claude-code';

export function listConfiguredBots(env: NodeJS.ProcessEnv = process.env): ConfiguredBot[] | null {
  if (env.BOTMUX_CORE_ONLY === '1') {
    // 与 bot-registry.maybeSynthesizeCoreOnlyConfig 同构：核心态无视磁盘上的 bots.json，身份只来自 env
    return [{ larkAppId: env.BOTMUX_API_ONLY_BOT || 'local_riff', cliId: env.BOTMUX_CORE_CLI || 'codex-app' }];
  }
  let raw: string;
  try {
    raw = readFileSync(resolveBotsConfigFile({ env }), 'utf8');
  } catch {
    return null;
  }
  return parseConfiguredBots(raw);
}

export function parseConfiguredBots(raw: string): ConfiguredBot[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ConfiguredBot[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.larkAppId !== 'string' || !e.larkAppId.trim()) continue;
    if (e.activationPending === true || e.activationDeactivating !== undefined || e.activationStarting !== undefined || e.activationCommitted !== undefined) continue;
    const displayName = typeof e.displayName === 'string' && e.displayName.trim() ? e.displayName.trim() : undefined;
    const cliId = typeof e.cliId === 'string' && e.cliId.trim() ? e.cliId.trim() : LEGACY_DEFAULT_CLI_ID;
    out.push({ larkAppId: e.larkAppId.trim(), ...(displayName ? { displayName } : {}), cliId });
  }
  return out;
}
