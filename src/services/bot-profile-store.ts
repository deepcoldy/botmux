/**
 * Team-level bot profile store: a short, human-facing **capability label** per
 * bot (keyed by larkAppId), separate from the full team role markdown.
 *
 * Why separate from the team role (see role-resolver.ts):
 * - The capability label is a one-liner used in the collaboration roster
 *   (`botmux bots list`) for discovery/selection — "后端 bot，擅长服务端排查".
 * - The full team role is the persona injected into the CLI `<role>` block.
 * Keeping them apart lets the roster stay scannable while the role stays rich.
 *
 * Storage: **one file per bot** at `{dataDir}/bot-profiles/{larkAppId}.json`.
 * Per-bot files (not one shared map) matter because production is one daemon
 * per bot: a shared read-modify-write map would lose updates when two daemons
 * write different bots' capabilities concurrently. Each daemon owns its bot's
 * file, so there is no cross-bot lost-update window. Same rationale as the
 * per-bot team-role files in role-resolver.ts.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** A capability label longer than this is almost certainly a full role, not a tag. */
const MAX_CAPABILITY_CHARS = 120;

export interface BotProfile {
  capability?: string;
  updatedAt: number;
  updatedBy?: string;
}

function profilesDir(dataDir: string): string {
  return join(dataDir, 'bot-profiles');
}

function profilePath(dataDir: string, larkAppId: string): string {
  return join(profilesDir(dataDir), `${larkAppId}.json`);
}

function readProfile(dataDir: string, larkAppId: string): BotProfile | null {
  const fp = profilePath(dataDir, larkAppId);
  if (!existsSync(fp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as BotProfile;
  } catch { /* corrupt — treat as absent */ }
  return null;
}

function writeProfileAtomic(dataDir: string, larkAppId: string, profile: BotProfile): void {
  const dir = profilesDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fp = profilePath(dataDir, larkAppId);
  const tmp = `${fp}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(profile, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/** Full profile for a bot, or null if none recorded. */
export function getBotProfile(dataDir: string, larkAppId: string): BotProfile | null {
  if (!larkAppId) return null;
  return readProfile(dataDir, larkAppId);
}

/** Just the capability label for a bot, or null. */
export function getBotCapability(dataDir: string, larkAppId: string): string | null {
  return getBotProfile(dataDir, larkAppId)?.capability ?? null;
}

/** Set (or overwrite) a bot's capability label. Trimmed and length-capped. */
export function setBotCapability(dataDir: string, larkAppId: string, capability: string, updatedBy?: string, now: number = Date.now()): void {
  if (!larkAppId) return;
  const label = capability.trim().slice(0, MAX_CAPABILITY_CHARS);
  writeProfileAtomic(dataDir, larkAppId, { capability: label, updatedAt: now, ...(updatedBy ? { updatedBy } : {}) });
}

/** Remove a bot's capability label (deletes its profile file). Returns true if one existed. */
export function clearBotCapability(dataDir: string, larkAppId: string): boolean {
  const fp = profilePath(dataDir, larkAppId);
  const had = readProfile(dataDir, larkAppId)?.capability !== undefined;
  try { unlinkSync(fp); } catch { /* already gone */ }
  return had;
}

/** All recorded profiles, keyed by larkAppId. */
export function listBotProfiles(dataDir: string): Record<string, BotProfile> {
  const dir = profilesDir(dataDir);
  const out: Record<string, BotProfile> = {};
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const larkAppId = f.slice(0, -'.json'.length);
    const p = readProfile(dataDir, larkAppId);
    if (p) out[larkAppId] = p;
  }
  return out;
}
