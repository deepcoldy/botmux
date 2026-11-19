import type { CliRuntimeConfig } from '../adapters/cli/runtime.js';
import type { CliId } from '../adapters/cli/types.js';
import type { CliLaunchMode } from '../core/cli-launch-mode.js';

/**
 * Persisted local bots: a fleet entry with no Feishu app.
 *
 * `larkAppId` stays the historical daemon / dashboard / session key, but for
 * these bots it is a stable local identity (`local_<slug>`), not a Feishu
 * `cli_` app id. `apiOnly` is what actually turns Feishu transport off;
 * `localIdentity` records that the id was minted for that purpose.
 */
export const LOCAL_BOT_ID_RE = /^local_[A-Za-z0-9._-]{1,80}$/;

export function isLocalBotId(id: unknown): id is string {
  return typeof id === 'string' && LOCAL_BOT_ID_RE.test(id);
}

/** Fleet `botmux start` must not call Feishu for these bots. */
export function botSkipsFeishuCredentialCheck(bot: { apiOnly?: unknown } | null | undefined): boolean {
  return bot?.apiOnly === true;
}

export function allocateLocalBotId(displayName: string | undefined, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugForLocalId(displayName);
  const first = `local_${base}`;
  if (!used.has(first)) return first;
  for (let n = 2; n < 1000; n++) {
    const candidate = `local_${base}_${n}`;
    if (!used.has(candidate) && isLocalBotId(candidate)) return candidate;
  }
  throw new Error('无法分配本地机器人 id');
}

/** Re-run allocation against the locked, latest fleet snapshot before an append. */
export function reallocateLocalBotId<T extends {
  larkAppId?: string;
  displayName?: string;
  name?: string;
}>(record: T, taken: Iterable<string>): T & { larkAppId: string } {
  return {
    ...record,
    larkAppId: allocateLocalBotId(record.displayName ?? record.name, taken),
  };
}

export interface LocalBotDraft {
  displayName?: string;
  cliId: CliId;
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
  cliPathOverride?: string;
  cliRuntime?: CliRuntimeConfig;
  workingDir?: string;
  defaultWorkingDir?: string;
  model?: string;
  backendType?: string;
  lang?: string;
  name?: string;
  existingIds: Iterable<string>;
}

export interface LocalBotRecord {
  larkAppId: string;
  apiOnly: true;
  localIdentity: true;
  cliId: CliId;
  displayName?: string;
  name?: string;
  wrapperCli?: string;
  cliLaunchMode?: CliLaunchMode;
  cliPathOverride?: string;
  cliRuntime?: CliRuntimeConfig;
  workingDir?: string;
  defaultWorkingDir?: string;
  model?: string;
  backendType?: string;
  lang?: 'zh' | 'en';
}

/** JSON object written to bots.json. No app secret and no Feishu owner. */
export function buildLocalBotRecord(draft: LocalBotDraft): LocalBotRecord {
  const displayName = draft.displayName?.trim() || undefined;
  const larkAppId = allocateLocalBotId(displayName ?? draft.name, draft.existingIds);
  const record: LocalBotRecord = {
    larkAppId,
    apiOnly: true,
    localIdentity: true,
    cliId: draft.cliId,
  };
  if (displayName) record.displayName = displayName;
  if (draft.name?.trim()) record.name = draft.name.trim();
  else if (displayName) record.name = displayName;
  if (draft.wrapperCli) record.wrapperCli = draft.wrapperCli;
  if (draft.cliLaunchMode) record.cliLaunchMode = draft.cliLaunchMode;
  if (draft.cliPathOverride) record.cliPathOverride = draft.cliPathOverride;
  if (draft.cliRuntime) record.cliRuntime = draft.cliRuntime;
  if (draft.workingDir) record.workingDir = draft.workingDir;
  if (draft.defaultWorkingDir) record.defaultWorkingDir = draft.defaultWorkingDir;
  if (draft.model?.trim()) record.model = draft.model.trim();
  if (draft.backendType) record.backendType = draft.backendType;
  if (draft.lang === 'zh' || draft.lang === 'en') record.lang = draft.lang;
  return record;
}

export interface FleetCredentialBot {
  larkAppId?: string;
  larkAppSecret?: string;
  apiOnly?: boolean;
}

/**
 * The credential half of `botmux start`. Local / apiOnly bots are skipped
 * before any secret check or `tenant_access_token` call. A normal Feishu bot
 * with a missing secret still fails closed. Network/unknown validation errors
 * stay warnings (the daemon retries) and do not land in the returned list.
 */
export async function findInvalidFleetCredentials(
  bots: FleetCredentialBot[],
  opts: {
    blockedBotIds?: ReadonlySet<string>;
    validate: (
      appId: string,
      secret: string,
      brand: 'feishu' | 'lark',
    ) => Promise<{ ok: true } | { ok: false; error: string; message: string }>;
    brandOf: (bot: FleetCredentialBot) => 'feishu' | 'lark';
    warn?: (line: string) => void;
  },
): Promise<Array<{ appId: string; reason: string }>> {
  const invalid: Array<{ appId: string; reason: string }> = [];
  for (const bot of bots) {
    if (bot.larkAppId && opts.blockedBotIds?.has(bot.larkAppId)) continue;
    if (botSkipsFeishuCredentialCheck(bot)) continue;
    if (!bot.larkAppId || !bot.larkAppSecret) {
      invalid.push({ appId: bot.larkAppId || '(空 appId)', reason: 'larkAppId/larkAppSecret 缺失' });
      continue;
    }
    const verdict = await opts.validate(bot.larkAppId, bot.larkAppSecret, opts.brandOf(bot));
    if (verdict.ok) continue;
    if (verdict.error === 'invalid_credentials') {
      invalid.push({ appId: bot.larkAppId, reason: verdict.message });
      continue;
    }
    opts.warn?.(`⚠️  [${bot.larkAppId}] 启动前凭证验证未成功（${verdict.error}）: ${verdict.message}`);
    opts.warn?.('   daemon 仍会启动；启动后 dispatcher 会自行重试。');
  }
  return invalid;
}

function slugForLocalId(displayName: string | undefined): string {
  const ascii = (displayName ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const base = ascii || 'bot';
  return isLocalBotId(`local_${base}`) ? base : 'bot';
}
