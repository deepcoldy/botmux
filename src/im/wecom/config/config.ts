import { validateWecomNativeCoreConfig, WECOM_NATIVE_CORE_KEYS, type WecomNativeCoreConfig } from './native-core-config.js';
import { validateWecomNativePlatformConfig, PLATFORM_KEYS, type WecomNativePlatformConfig } from './native-platform-config.js';
import { validateWecomSessionMode, type WecomSessionMode } from './session-mode.js';
import { validateWecomCommandTriggers, wecomTriggerPassthrough } from './command-triggers.js';
import type { CommandTriggerConfig } from '../../../bot-registry.js';
import { validateWecomMessageConfig, type WecomMessageConfig } from './message-config.js';
import type { WecomManagedCoreSettings } from './managed-core-env.js';
import { CORE_ONLY_BACKENDS, validateCoreOnlyBotProfile, type CoreOnlyBotProfile } from '../../../core/core-only-bot-profile.js';
import { parseBotConfigsFromText } from '../../../bot-registry.js';
import { readFileSync, openSync, closeSync, fstatSync, constants, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { withFileLock } from '../../../utils/file-lock.js';
import { validateWecomCoreUrl } from './core-url.js';

export interface WecomConfig {
  native?: WecomNativeCoreConfig & WecomNativePlatformConfig;
  botId: string;
  displayName?: string;
  secretEnv?: string;
  secretFile?: string;
  coreUrl: string;
  allowedUsers: string[];
  stateDir?: string;
  message?: WecomMessageConfig;
  commandTriggers?: CommandTriggerConfig;
  sessionMode?: WecomSessionMode;
  sessionModeEpoch?: string;
  role?: { content: string; injectMode: 'every' | 'once' };
  blockedUsers?: string[];
  managedCore?: WecomManagedCoreSettings;
}

/**
 * `native` keys earlier versions wrote and this one no longer reads. A
 * configuration file that still carries one is accepted as before: the key is
 * dropped on parse (whatever its value), so the connection starts, and a later
 * Dashboard save does not write it back. `approverUsers` is not lost with it:
 * its users join `allowedUsers` first (see mergeRetiredApprovers).
 */
const RETIRED_NATIVE_KEYS: readonly string[] = [
  'terminalBaseUrl',
  'repositories',
  'console',
  'substitutePrompt',
  'feedbackButtonAlign',
  'peerTrust',
  'grantDelegateBots',
  'approverUsers',
  'restrictGrantCommands',
  'replyDelivery',
  'autoStartOnGroupJoin',
  'autoStartOnGroupJoinPrompt',
  'autoStartOnGroupJoinSeed',
  'groupJoinCommandEnabled',
  'groupJoinCommand',
  'autoStartExcludedChats',
  'regularGroupMentionMode',
  'slashCommands',
  'privateCard',
  'replyCardNativeCot',
  'replyStyle',
  'askOptionLayout',
];

/**
 * Allowed users are the approvers now. The users of a retired
 * `native.approverUsers` list keep the operate and approval rights they had:
 * they join `allowedUsers` (its order first, duplicates dropped), so every
 * reader of the parsed configuration — the gateway, the Dashboard and every
 * save that writes the parsed result back — sees them as allowed users.
 * Entries that could never be an allowed user (not a non-empty string, `*`)
 * are left out rather than failing the whole configuration.
 */
function mergeRetiredApprovers(allowedUsers: string[], native: unknown): string[] {
  const approvers = native && typeof native === 'object' && !Array.isArray(native)
    ? (native as Record<string, unknown>).approverUsers
    : undefined;
  if (!Array.isArray(approvers)) {
    return allowedUsers;
  }
  const merged = [...allowedUsers];
  for (const user of approvers) {
    if (typeof user === 'string' && user.trim() && user !== '*' && !merged.includes(user)) {
      merged.push(user);
    }
  }
  return merged;
}

export function parseWecomConfig(raw: unknown): WecomConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('配置必须为 JSON 对象');
  }
  const value = raw as Record<string, unknown>;
  for (const key of ['botId', 'coreUrl']) {
    if (typeof value[key] !== 'string' || !(value[key] as string).trim()) {
      throw new Error(`配置缺少 ${key}`);
    }
  }
  if (Boolean(value.secretEnv) === Boolean(value.secretFile)) {
    throw new Error('配置必须指定唯一凭据来源（环境变量或本地凭据文件）');
  }
  if (value.secretEnv !== undefined
    && (typeof value.secretEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.secretEnv))) {
    throw new Error('凭据环境变量名称无效');
  }
  if (value.secretFile !== undefined && (typeof value.secretFile !== 'string' || !isAbsolute(value.secretFile))) {
    throw new Error('凭据文件必须为绝对路径');
  }
  if (!Array.isArray(value.allowedUsers)
    || !value.allowedUsers.length
    || value.allowedUsers.some(item => typeof item !== 'string' || !item.trim() || item === '*')) {
    throw new Error('allowedUsers 必须显式列出真实企业微信 userid，不能使用通配符');
  }
  if (value.stateDir !== undefined && (typeof value.stateDir !== 'string' || !value.stateDir.trim())) {
    throw new Error('stateDir 必须为目录路径');
  }
  if (value.displayName !== undefined
    && (typeof value.displayName !== 'string'
      || value.displayName.length > 100
      || /[\x00-\x1f]/.test(value.displayName))) {
    throw new Error('机器人显示名称无效');
  }
  if (value.message !== undefined) {
    validateWecomMessageConfig(value.message);
  }
  if (value.blockedUsers !== undefined
    && (!Array.isArray(value.blockedUsers)
      || value.blockedUsers.some(item => typeof item !== 'string' || !item.trim() || item === '*'))) {
    throw new Error('blockedUsers 无效');
  }
  if ((value.allowedUsers as string[]).every(user => (value.blockedUsers as string[] | undefined)?.includes(user))) {
    throw new Error('必须保留至少一个未被屏蔽的授权用户');
  }
  if (value.role !== undefined) {
    const role = value.role as Record<string, unknown>;
    if (!role
      || typeof role !== 'object'
      || Array.isArray(role)
      || Object.keys(role).some(key => !['content', 'injectMode'].includes(key))
      || typeof role.content !== 'string'
      || role.content.length > 100000
      || role.content.includes('\0')
      || !['every', 'once'].includes(String(role.injectMode))) {
      throw new Error('角色配置无效');
    }
  }
  const coreOrigin = validateWecomCoreUrl(value.coreUrl as string);
  if (value.managedCore !== undefined) {
    if (!value.managedCore || typeof value.managedCore !== 'object' || Array.isArray(value.managedCore)) {
      throw new Error('托管 core 配置无效');
    }
    const core = value.managedCore as Record<string, unknown>;
    if ((core.model !== undefined
      && (typeof core.model !== 'string' || core.model.length > 200 || /[\x00-\x1f]/.test(core.model)))
      || typeof core.cli !== 'string' || !/^[a-z][a-z0-9-]*$/.test(core.cli)
      || !(CORE_ONLY_BACKENDS as readonly unknown[]).includes(core.backend)
      || !Number.isInteger(core.port) || (core.port as number) < 1 || (core.port as number) > 65535
      || typeof core.botId !== 'string' || !/^local_[a-z0-9_-]+$/.test(core.botId)
      || typeof core.workingDirectory !== 'string' || !isAbsolute(core.workingDirectory)
      || typeof core.stateDir !== 'string' || !isAbsolute(core.stateDir)
      || Number(new URL(coreOrigin).port || 80) !== core.port) {
      throw new Error('托管 core 配置无效');
    }
  }
  if (value.sessionMode !== undefined) {
    validateWecomSessionMode(value.sessionMode);
  }
  if (value.sessionModeEpoch !== undefined
    && (typeof value.sessionModeEpoch !== 'string' || !/^[a-f0-9-]{36}$/.test(value.sessionModeEpoch))) {
    throw new Error('wecom_invalid_session_mode');
  }
  const result = { ...value } as unknown as WecomConfig;
  // The retired local business section (owner, secretary, ledger, hand-over,
  // explicit assist) is dropped whatever it holds; a later save does not write it back.
  delete (result as unknown as Record<string, unknown>).business;
  result.allowedUsers = mergeRetiredApprovers(value.allowedUsers as string[], value.native);
  if (value.native !== undefined) {
    if (!value.native
      || typeof value.native !== 'object'
      || Array.isArray(value.native)
      || Object.keys(value.native).some(k => ![...WECOM_NATIVE_CORE_KEYS, ...PLATFORM_KEYS, ...RETIRED_NATIVE_KEYS].includes(k as any))) {
      throw new Error('wecom_invalid_native_configuration');
    }
    result.native = {
      ...validateWecomNativeCoreConfig(value.native),
      ...validateWecomNativePlatformConfig(value.native),
    };
  }
  if (result.sessionMode !== undefined) {
    result.sessionMode = validateWecomSessionMode(result.sessionMode);
  }
  if (result.message !== undefined) {
    result.message = validateWecomMessageConfig(result.message);
  }
  if (result.managedCore?.botConfig !== undefined) {
    const core = result.managedCore;
    const profile = validateCoreOnlyBotProfile(core.botConfig);
    const normalized = parseBotConfigsFromText(JSON.stringify([{
      ...profile,
      larkAppId: core.botId,
      apiOnly: true,
      cliId: core.cli,
      model: core.model,
      backendType: core.backend,
    }]))[0];
    const canonical: CoreOnlyBotProfile = {};
    for (const key of Object.keys(profile) as (keyof CoreOnlyBotProfile)[]) {
      // Persist the same representation the worker consumes. Inapplicable
      // CLI-specific knobs and absent/default optional values are removed.
      const next = (normalized as unknown as Record<string, unknown>)[key];
      if (next !== undefined) {
        canonical[key] = next;
      }
    }
    result.managedCore = { ...core, botConfig: canonical };
  }
  if (value.commandTriggers !== undefined) {
    result.commandTriggers = validateWecomCommandTriggers(
      value.commandTriggers,
      wecomTriggerPassthrough(
        result.managedCore?.cli ?? 'codex',
        result.managedCore?.botConfig?.customPassthroughCommands as string[] | undefined,
        result.managedCore?.botConfig?.cliPathOverride as string | undefined,
      ),
    );
  }
  return result;
}

export function readWecomCredentialFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()
      || (process.getuid && stat.uid !== process.getuid())
      || (stat.mode & 0o077) !== 0
      || stat.size > 8192) {
      throw new Error('unsafe');
    }
    const secret = readFileSync(fd, 'utf8').trim();
    if (!secret || secret.includes('\n') || secret.includes('\r')) {
      throw new Error('invalid');
    }
    return secret;
  } catch {
    throw new Error('无法读取安全凭据文件：必须为当前用户可读、权限0600的普通文件');
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/**
 * The configuration names a credential environment variable (`secretEnv`) that
 * is unset or empty in this process's environment. Carries the variable's
 * NAME only, never a value.
 */
export class WecomCredentialEnvMissingError extends Error {
  constructor(readonly variable: string) {
    super('未设置配置指定的凭据环境变量');
    this.name = 'WecomCredentialEnvMissingError';
  }
}

export function loadWecomSecret(config: WecomConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.secretFile) {
    return readWecomCredentialFile(config.secretFile);
  }
  const secret = config.secretEnv ? env[config.secretEnv] : undefined;
  if (!secret?.trim()) {
    throw config.secretEnv ? new WecomCredentialEnvMissingError(config.secretEnv) : new Error('未设置配置指定的凭据环境变量');
  }
  return secret.trim();
}

export function readWecomConfigSnapshot(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
}

/** Immutable credential generation + one atomic configuration pointer commit.
 * Configuration never references a partially-written credential. On pre-commit
 * failure only the new unused generation is removed. Old generations remain
 * readable for concurrent readers and operator rollback. */
export async function commitWecomConfiguration(options: {
  file: string;
  previous: string | undefined;
  config: WecomConfig;
  newSecret?: string;
  write?: typeof atomicWriteFileSync;
  /** Recheck the onboarding generation after acquiring the configuration lock. */
  beforeCommit?: () => void;
}): Promise<void> {
  const { file, previous } = options;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(file, async () => {
    options.beforeCommit?.();
    if (readWecomConfigSnapshot(file) !== previous) {
      throw new Error('配置已被另一个向导修改，请重新运行');
    }
    const write = options.write ?? atomicWriteFileSync;
    let generated: string | undefined;
    const config = { ...options.config };
    try {
      if (options.newSecret !== undefined) {
        if (!options.newSecret.trim()
          || options.newSecret.includes('\n')
          || options.newSecret.includes('\r')
          || Buffer.byteLength(options.newSecret) > 8192) {
          throw new Error('凭据格式无效');
        }
        const credentials = join(dirname(file), 'credentials');
        mkdirSync(credentials, { recursive: true, mode: 0o700 });
        generated = join(credentials, `${randomUUID()}.secret`);
        write(generated, options.newSecret, { mode: 0o600, durable: true, followTargetSymlink: false });
        delete config.secretEnv;
        config.secretFile = generated;
      }
      const normalized = parseWecomConfig(config);
      const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
      write(file, serialized, { mode: 0o600, durable: true, followTargetSymlink: false });
    } catch (error) {
      // atomicWrite may fail flushing the directory AFTER its rename committed.
      // Never remove a generation that the visible configuration already names.
      let referenced = false;
      try {
        referenced = JSON.parse(readFileSync(file, 'utf8')).secretFile === generated;
      } catch {
        /* old/absent config */
      }
      if (generated && !referenced) {
        try {
          unlinkSync(generated);
        } catch {
          /* best effort unused-generation cleanup */
        }
      }
      throw error;
    }
  }, { maxWaitMs: 100 });
}
