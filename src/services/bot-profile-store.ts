/**
 * Team-level bot profile store: a short, human-facing **capability label** plus
 * structured **specialties** tags per bot (keyed by larkAppId), separate from
 * the full team role markdown.
 *
 * Why separate from the team role (see role-resolver.ts):
 * - The capability label is a one-liner used in the collaboration roster
 *   (`botmux bots list`) for discovery/selection — "后端 bot，擅长服务端排查".
 * - `specialties` is a structured string[] of short tags (e.g. ["backend",
 *   "pr-review"]) — the machine-matchable discovery signal reported to the
 *   centralized platform (BotInfo.specialties) so teammates can find a bot by
 *   what it's good at. Self-reported → display/selection only, NEVER a
 *   trusted credential (deliberately unrelated to the config `capabilities`
 *   field, which gates VC actions).
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

/** Bounds for structured specialties tags. Discovery labels are short by design;
 *  cap both count and per-tag length so a bad writer can't bloat the heartbeat
 *  payload (specialties ride every register/heartbeat to the platform). */
const MAX_SPECIALTIES = 20;
const MAX_SPECIALTY_CHARS = 40;

export interface BotProfile {
  capability?: string;
  /** Structured discovery tags reported to the platform as BotInfo.specialties.
   *  Self-reported, display-only — never a trusted capability credential. */
  specialties?: string[];
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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const p = parsed as BotProfile;
      // Normalize specialties on read so a hand-edited / legacy file can never
      // leak a dirty value (non-array, dupes, over-long) to the platform. Only
      // materialize the field when the file actually had one.
      if ('specialties' in p) p.specialties = normalizeSpecialties(p.specialties);
      return p;
    }
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

/** Normalize a specialties list: trim, drop empties, dedupe (order-preserving),
 *  cap per-tag length and total count. Non-array → []. */
function normalizeSpecialties(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, MAX_SPECIALTY_CHARS);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SPECIALTIES) break;
  }
  return out;
}

/** Structured discovery tags for a bot (empty array if none). */
export function getBotSpecialties(dataDir: string, larkAppId: string): string[] {
  return getBotProfile(dataDir, larkAppId)?.specialties ?? [];
}

/**
 * Set (or overwrite) a bot's capability label. Trimmed and length-capped.
 * Merges into the existing profile so it never clobbers `specialties`.
 */
export function setBotCapability(dataDir: string, larkAppId: string, capability: string, updatedBy?: string, now: number = Date.now()): void {
  if (!larkAppId) return;
  const label = capability.trim().slice(0, MAX_CAPABILITY_CHARS);
  const existing = readProfile(dataDir, larkAppId);
  writeProfileAtomic(dataDir, larkAppId, {
    ...(existing?.specialties ? { specialties: existing.specialties } : {}),
    capability: label,
    updatedAt: now,
    ...(updatedBy ? { updatedBy } : {}),
  });
}

/**
 * Set (or overwrite) a bot's specialties tags. Normalized (trim/dedupe/capped).
 * Merges into the existing profile so it never clobbers the `capability` label.
 * An empty list persists as an explicit `[]` (owner cleared their tags).
 */
export function setBotSpecialties(dataDir: string, larkAppId: string, specialties: string[], updatedBy?: string, now: number = Date.now()): void {
  if (!larkAppId) return;
  const tags = normalizeSpecialties(specialties);
  const existing = readProfile(dataDir, larkAppId);
  writeProfileAtomic(dataDir, larkAppId, {
    ...(existing?.capability ? { capability: existing.capability } : {}),
    specialties: tags,
    updatedAt: now,
    ...(updatedBy ? { updatedBy } : {}),
  });
}

/** Remove a bot's capability label. Preserves `specialties`. Returns true if a
 *  label existed. Deletes the whole profile file only when nothing else remains. */
export function clearBotCapability(dataDir: string, larkAppId: string): boolean {
  const existing = readProfile(dataDir, larkAppId);
  const had = existing?.capability !== undefined;
  if (existing?.specialties && existing.specialties.length > 0) {
    // Keep the file — specialties still live here. Preserve updatedBy so the
    // audit trail (who last touched this profile) survives a capability clear.
    writeProfileAtomic(dataDir, larkAppId, {
      specialties: existing.specialties,
      updatedAt: Date.now(),
      ...(existing.updatedBy ? { updatedBy: existing.updatedBy } : {}),
    });
  } else {
    try { unlinkSync(profilePath(dataDir, larkAppId)); } catch { /* already gone */ }
  }
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
