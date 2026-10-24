/**
 * 共享的 bots.json 读改写原语：跨进程文件锁 + 原子 rename。
 * oncall-store 与 grant-store 共用，保证对同一 bots.json 的并发写不丢更新。
 */
import { promises as fsp } from 'node:fs';
import { getLoadedConfigPath, parseBotConfigsFromText } from '../bot-registry.js';
import { assertQuotaFallbackGraphAcyclic } from './quota-fallback.js';
import { withFileLock } from '../utils/file-lock.js';
import { assertCodexInstanceConfigWrite } from './codex-instance-config-guard.js';
import {
  assertChangedBotConfigInvariants,
  botConfigInvariantError,
} from './bot-config-invariants.js';
import {
  assertDurableConfigMutationAllowed,
  runDurableConfigMutation,
} from './durable-config-mutation.js';
export { botConfigInvariantError } from './bot-config-invariants.js';
export type { BotConfigInvariantError } from './bot-config-invariants.js';

export async function readRawConfig(path: string): Promise<any[]> {
  const raw = JSON.parse(await fsp.readFile(path, 'utf-8'));
  if (!Array.isArray(raw)) throw new Error(`Config file is not a JSON array: ${path}`);
  return raw;
}

/**
 * Run the same content parse the daemon loader uses, but only for entries this
 * write creates or changes. Every bots.json write surface must leave the bots
 * it touched in a loader-accepted shape: one changed entry failing a content
 * gate (e.g. a codexProfile combined with an unsupported launch) makes
 * parseBotConfigsFromText throw for the WHOLE file and blocks every Bot on the
 * next daemon start. An UNCHANGED legacy entry that a newer build would reject
 * is deliberately skipped (same semantics as
 * assertChangedBotConfigInvariants), so one invalid legacy bot cannot prevent
 * repairing another. Cross-entry structural checks (quota graph, invariants)
 * run separately on the whole generation.
 */
export function assertNextBotsGenerationParses(previous: any[], next: any[]): void {
  for (let index = 0; index < next.length; index++) {
    const entry = next[index];
    const previousEntry = entry?.larkAppId
      ? previous.find(candidate => candidate?.larkAppId === entry.larkAppId)
      : previous[index];
    if (previousEntry !== undefined && JSON.stringify(previousEntry) === JSON.stringify(entry)) continue;
    parseBotConfigsFromText(JSON.stringify([entry]));
  }
}

export async function writeRawConfigAtomic(path: string, raw: any[]): Promise<void> {
  assertDurableConfigMutationAllowed('bots');
  let previous: any[] = [];
  try { previous = await readRawConfig(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  assertCodexInstanceConfigWrite(previous, raw);
  assertChangedBotConfigInvariants(previous, raw);
  // Validate the complete next generation, not the currently loaded registry.
  // Callers invoke this while holding the cross-process lock.
  assertQuotaFallbackGraphAcyclic(raw);
  assertNextBotsGenerationParses(previous, raw);
  const tmp = path + '.tmp.' + process.pid;
  // bots.json 含 appSecret —— 临时文件即以 0o600 写入，rename 后保持私有权限。
  await fsp.writeFile(tmp, JSON.stringify(raw, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await fsp.rename(tmp, path);
}

export function findEntryIndex(raw: any[], larkAppId: string): number {
  return raw.findIndex((e: any) => e?.larkAppId === larkAppId);
}

export function requireConfigPath(): string {
  const p = getLoadedConfigPath();
  if (!p) throw new Error('Bot config path unknown — cannot persist config changes');
  return p;
}

/**
 * 在跨进程锁内对某个 bot 条目做 read-modify-write。`mutate` 拿到最新磁盘快照决定
 * 写什么；返回 `{ write:false }` 表示不写。沿用 oncall-store 原有语义。
 */
export async function rmwBotEntry<T>(
  larkAppId: string,
  mutate: (entry: any, raw: any[]) => { write: boolean; result: T } | T | Promise<{ write: boolean; result: T } | T>,
): Promise<{ ok: true; result: T } | { ok: false; reason: string }> {
  const path = requireConfigPath();
  return runDurableConfigMutation({
    scope: 'bots',
    path,
    mutation: () => withFileLock(path, async () => {
      const raw = await readRawConfig(path);
      const idx = findEntryIndex(raw, larkAppId);
      if (idx < 0) return { ok: false as const, reason: 'bot_not_in_config' };
      const entry = raw[idx];
      const out = await mutate(entry, raw);
      const persist = async () => {
        // Loader-level gates (parseBotConfigsFromText included) can still reject
        // a mutation whose field-specific checks passed (e.g. a codexProfile
        // combined with a field another write path just changed). Surface that
        // as a structured failure instead of a throw, so callers keep the old
        // in-memory config and return an error to the operator.
        try {
          await writeRawConfigAtomic(path, raw);
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, reason: (error as Error).message };
        }
      };
      if (out && typeof out === 'object' && 'write' in (out as any)) {
        const wrap = out as { write: boolean; result: T };
        if (wrap.write) {
          const invariantError = botConfigInvariantError(entry);
          if (invariantError) return { ok: false as const, reason: invariantError };
          const w = await persist();
          if (!w.ok) return { ok: false as const, reason: w.reason };
        }
        return { ok: true as const, result: wrap.result };
      }
      const invariantError = botConfigInvariantError(entry);
      if (invariantError) return { ok: false as const, reason: invariantError };
      const w = await persist();
      if (!w.ok) return { ok: false as const, reason: w.reason };
      return { ok: true as const, result: out as T };
    }),
  });
}
