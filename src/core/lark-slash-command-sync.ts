/**
 * Publishes this bot's slash commands to the Lark client's "/" command panel
 * (Open Platform `application/v7/app_slash_commands`). The panel only helps the
 * user type: a picked command still arrives as an ordinary message and goes
 * through the normal router, so a stale panel can never grant anything.
 *
 * Only commands this daemon published itself (recorded in a per-bot state file)
 * are ever updated or deleted; commands an operator added on the platform are
 * left alone unless they collide with a botmux name.
 */
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { getBot, getBotClient } from '../bot-registry.js';
import { t, localeForBot } from '../i18n/index.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { isJsonObject, readJsonFileSoft } from '../utils/json-file.js';
import { logger } from '../utils/logger.js';
import { COMMANDS } from './command-schema.js';
import { pluginCommandGateway } from './plugins/commands/runtime.js';

const API = '/open-apis/application/v7/app_slash_commands';
const MAX_COMMANDS = 100;
const MAX_DESCRIPTION = 80;
const CHECK_INTERVAL_MS = 60_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
export const SLASH_COMMAND_SCOPE = 'application:app_slash_command:write';

export interface LarkSlashCommandDescription {
  default_value: string;
  i18n: { zh_cn: string; en_us: string };
}
export interface LarkSlashCommand { command: string; description: LarkSlashCommandDescription }
export interface ExistingLarkSlashCommand { commandId: string; command: string; description?: Partial<LarkSlashCommandDescription> }

export type SlashCommandOp =
  | { op: 'create'; command: LarkSlashCommand }
  | { op: 'update'; commandId: string; command: LarkSlashCommand }
  | { op: 'delete'; commandId: string; command: string };

/** `/help` lines look like `/cmd <args>  (alias /x)  - text`; the panel wants just the text. */
function helpText(key: string, locale: 'zh' | 'en'): string {
  const line = t(key, { cliName: 'CLI' }, locale);
  const idx = line.indexOf(' - ');
  const text = (idx >= 0 ? line.slice(idx + 3) : line).replace(/\s+/g, ' ').trim();
  return Array.from(text).length > MAX_DESCRIPTION ? `${Array.from(text).slice(0, MAX_DESCRIPTION - 1).join('')}…` : text;
}

/** Built-in primary names that have help text (aliases and CLI-specific commands excluded) + this bot's plugin commands. */
export function buildDesiredLarkSlashCommands(larkAppId: string): LarkSlashCommand[] {
  const cliId = getBot(larkAppId).config.cliId;
  const defaultLocale = localeForBot(larkAppId) === 'en' ? 'en' : 'zh';
  const out = new Map<string, LarkSlashCommand>();
  for (const spec of COMMANDS) {
    if (spec.help.length === 0 || (spec.cliId && spec.cliId !== cliId)) continue;
    const zh = helpText(spec.help[0], 'zh');
    const en = helpText(spec.help[0], 'en');
    out.set(spec.name.slice(1), { command: spec.name.slice(1), description: { default_value: defaultLocale === 'en' ? en : zh, i18n: { zh_cn: zh, en_us: en } } });
  }
  for (const entry of pluginCommandGateway.list(larkAppId)) {
    if (entry.pluginId === null || !entry.description) continue;
    const name = entry.name.slice(1);
    if (out.has(name)) continue;
    const text = Array.from(entry.description).slice(0, MAX_DESCRIPTION).join('');
    out.set(name, { command: name, description: { default_value: text, i18n: { zh_cn: text, en_us: text } } });
  }
  return [...out.values()].slice(0, MAX_COMMANDS);
}

const sameDescription = (a: Partial<LarkSlashCommandDescription> | undefined, b: LarkSlashCommandDescription): boolean =>
  a?.default_value === b.default_value && a?.i18n?.zh_cn === b.i18n.zh_cn && a?.i18n?.en_us === b.i18n.en_us;

/** Pure diff: create/update what is wanted, delete only what botmux published earlier and no longer wants. */
export function planSlashCommandSync(
  desired: readonly LarkSlashCommand[],
  existing: readonly ExistingLarkSlashCommand[],
  previouslyManaged: readonly string[],
): SlashCommandOp[] {
  const byName = new Map(existing.map(e => [e.command, e]));
  const wanted = new Set(desired.map(d => d.command));
  const ops: SlashCommandOp[] = [];
  for (const command of desired) {
    const current = byName.get(command.command);
    if (!current) ops.push({ op: 'create', command });
    else if (!sameDescription(current.description, command.description)) ops.push({ op: 'update', commandId: current.commandId, command });
  }
  for (const name of previouslyManaged) {
    const current = byName.get(name);
    if (current && !wanted.has(name)) ops.push({ op: 'delete', commandId: current.commandId, command: name });
  }
  return ops;
}

interface SyncState { fingerprint?: string; managed?: string[] }

const statePath = (larkAppId: string): string => join(config.session.dataDir, `lark-slash-commands-${larkAppId}.json`);

function readState(larkAppId: string): SyncState {
  return readJsonFileSoft<SyncState>(statePath(larkAppId), {
    label: 'lark-slash-commands',
    fallback: () => ({}),
    validate: (raw): raw is SyncState => isJsonObject(raw),
  });
}

async function larkRequest(larkAppId: string, method: string, url: string, data?: unknown): Promise<any> {
  const res: any = await (getBotClient(larkAppId) as any).request({ method, url, ...(data ? { data } : {}) });
  if (res?.code !== 0 && res?.code !== undefined) {
    throw new Error(`${method} ${url} failed: code=${res.code} msg=${res.msg ?? ''}`);
  }
  return res?.data ?? {};
}

function parseExisting(data: any): ExistingLarkSlashCommand[] {
  const items: unknown[] = Array.isArray(data?.items) ? data.items
    : Array.isArray(data?.slash_commands) ? data.slash_commands
      : Array.isArray(data?.commands) ? data.commands : [];
  return items.flatMap((raw: any) => {
    const commandId = raw?.command_id ?? raw?.id;
    const command = raw?.command ?? raw?.name;
    return typeof commandId === 'string' && typeof command === 'string'
      ? [{ commandId, command: command.replace(/^\//, ''), description: raw?.description }]
      : [];
  });
}

/** One reconcile pass; skipped when nothing changed since the last successful pass. */
export async function syncLarkSlashCommands(larkAppId: string): Promise<{ skipped: boolean; ops: number }> {
  const desired = buildDesiredLarkSlashCommands(larkAppId);
  const fingerprint = createHash('sha256').update(JSON.stringify(desired)).digest('hex');
  const state = readState(larkAppId);
  if (state.fingerprint === fingerprint) return { skipped: true, ops: 0 };

  const existing = parseExisting(await larkRequest(larkAppId, 'GET', API));
  const ops = planSlashCommandSync(desired, existing, state.managed ?? []);
  for (const op of ops) {
    if (op.op === 'create') await larkRequest(larkAppId, 'POST', API, op.command);
    else if (op.op === 'update') await larkRequest(larkAppId, 'PATCH', `${API}/${encodeURIComponent(op.commandId)}`, { description: op.command.description });
    else await larkRequest(larkAppId, 'DELETE', `${API}/${encodeURIComponent(op.commandId)}`);
  }
  atomicWriteFileSync(statePath(larkAppId), JSON.stringify({ fingerprint, managed: desired.map(d => d.command) }, null, 2));
  return { skipped: false, ops: ops.length };
}

/**
 * Sync at startup, then re-check every minute so enabling/disabling a plugin or
 * changing the bot's CLI reaches the panel without a restart. Failures (most
 * often the missing scope) are logged once and retried after a cool-down.
 */
export function startLarkSlashCommandSync(larkAppId: string): () => void {
  let failedAt = 0;
  let running = false;
  const tick = async () => {
    if (running || (failedAt && Date.now() - failedAt < RETRY_AFTER_FAILURE_MS)) return;
    running = true;
    try {
      const result = await syncLarkSlashCommands(larkAppId);
      failedAt = 0;
      if (!result.skipped) logger.info(`[slash-command-sync] app=${larkAppId} published to Lark (${result.ops} change(s))`);
    } catch (err) {
      failedAt = Date.now();
      logger.warn(`[slash-command-sync] app=${larkAppId} failed (needs scope ${SLASH_COMMAND_SCOPE}; retry in 10m): ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => { void tick(); }, 5_000);
  const timer = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  first.unref?.();
  timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}
