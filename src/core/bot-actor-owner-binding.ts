import { readFile } from 'node:fs/promises';

export interface BotActorOwnerBinding {
  /** Target-app-scoped open_id observed for the calling Bot. */
  sourceBotOpenId: string;
  /** Tenant-stable union_id observed for the same calling Bot. */
  sourceBotUnionId: string;
  /** Tenant-stable human Owner selected by deployment policy. */
  ownerUnionId: string;
  /** Canonical email that the target App must read back for ownerUnionId. */
  ownerEmail: string;
}

const OPEN_ID_RE = /^ou_[A-Za-z0-9]+$/;
const UNION_ID_RE = /^on_[A-Za-z0-9]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const EXACT_KEYS = ['ownerEmail', 'ownerUnionId', 'sourceBotOpenId', 'sourceBotUnionId'];
const MAX_BINDINGS = 256;

export type CanonicalBotActorOwnerBindingsResult =
  | { ok: true; bindings: BotActorOwnerBinding[] | undefined }
  | {
    ok: false;
    reason:
      | 'config_path_unavailable'
      | 'config_read_failed'
      | 'config_invalid_json'
      | 'config_invalid_shape'
      | 'target_missing'
      | 'target_ambiguous'
      | 'bindings_invalid';
  };

function canonicalEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim();
  if (!email || email !== email.toLowerCase() || email.length > 320 || !EMAIL_RE.test(email)) {
    return undefined;
  }
  return email;
}

/**
 * Parse the receiver-owned Bot→Owner policy from bots.json.
 *
 * This is a credential-selection boundary, so malformed entries, unknown keys
 * and duplicate source identities reject the whole Bot config instead of being
 * ignored. A caller cannot populate this value: only the target deployment's
 * canonical bots.json can.
 *
 * `null` means the same as "absent" (policy disabled): it is the conventional
 * hand-edited/frontend spelling for "clear this field", and the IPC clear path
 * deletes the key outright. Treating it as an array would throw out of config
 * parsing at startup and prevent every daemon from booting.
 */
export function normalizeBotActorOwnerBindings(
  value: unknown,
  label = 'botActorOwnerBindings',
): BotActorOwnerBinding[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_BINDINGS) throw new Error(`${label} exceeds ${MAX_BINDINGS} entries`);

  const result: BotActorOwnerBinding[] = [];
  const sourceOpenIds = new Set<string>();
  const sourceUnionIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    const entryLabel = `${label}[${index}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${entryLabel} must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== EXACT_KEYS.length || keys.some((key, i) => key !== EXACT_KEYS[i])) {
      throw new Error(`${entryLabel} must contain exactly ${EXACT_KEYS.join(', ')}`);
    }
    const sourceBotOpenId = typeof record.sourceBotOpenId === 'string'
      ? record.sourceBotOpenId.trim()
      : '';
    const sourceBotUnionId = typeof record.sourceBotUnionId === 'string'
      ? record.sourceBotUnionId.trim()
      : '';
    const ownerUnionId = typeof record.ownerUnionId === 'string'
      ? record.ownerUnionId.trim()
      : '';
    const ownerEmail = canonicalEmail(record.ownerEmail);
    if (!OPEN_ID_RE.test(sourceBotOpenId)) throw new Error(`${entryLabel}.sourceBotOpenId is invalid`);
    if (!UNION_ID_RE.test(sourceBotUnionId)) throw new Error(`${entryLabel}.sourceBotUnionId is invalid`);
    if (!UNION_ID_RE.test(ownerUnionId)) throw new Error(`${entryLabel}.ownerUnionId is invalid`);
    if (!ownerEmail) throw new Error(`${entryLabel}.ownerEmail must be a canonical lowercase email`);
    if (sourceOpenIds.has(sourceBotOpenId) || sourceUnionIds.has(sourceBotUnionId)) {
      throw new Error(`${entryLabel} duplicates a source Bot identity`);
    }
    sourceOpenIds.add(sourceBotOpenId);
    sourceUnionIds.add(sourceBotUnionId);
    result.push({ sourceBotOpenId, sourceBotUnionId, ownerUnionId, ownerEmail });
  }
  return result.length > 0 ? result : undefined;
}

/** Exact two-factor lookup over Lark-attested Bot open_id + union_id. */
export function findBotActorOwnerBinding(
  bindings: readonly BotActorOwnerBinding[] | undefined,
  sourceBotOpenId: string | undefined,
  sourceBotUnionId: string | undefined,
): BotActorOwnerBinding | undefined {
  if (!sourceBotOpenId || !sourceBotUnionId) return undefined;
  return bindings?.find(binding => binding.sourceBotOpenId === sourceBotOpenId
    && binding.sourceBotUnionId === sourceBotUnionId);
}

/**
 * Read the receiver-owned policy from the exact bots.json that the daemon
 * pinned at startup.
 *
 * The audited mutation path updates the local daemon registry immediately, but
 * a sibling Pod has an independent in-memory registry and ByteNAS does not
 * provide a trustworthy cross-Pod watch contract. Security-sensitive Bot
 * turns therefore re-read this single canonical file instead of treating one
 * process's memory as fleet-wide truth. Every malformed/unavailable state
 * fails closed to "no Owner"; the caller never falls back to another path or
 * to its stale in-memory snapshot.
 */
export async function readCanonicalBotActorOwnerBindings(
  configPath: string | undefined,
  targetLarkAppId: string,
): Promise<CanonicalBotActorOwnerBindingsResult> {
  if (!configPath) return { ok: false, reason: 'config_path_unavailable' };

  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch {
    return { ok: false, reason: 'config_read_failed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'config_invalid_json' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'config_invalid_shape' };

  const matches = parsed.filter((entry): entry is Record<string, unknown> =>
    !!entry && typeof entry === 'object' && !Array.isArray(entry)
      && entry.larkAppId === targetLarkAppId);
  if (matches.length === 0) return { ok: false, reason: 'target_missing' };
  if (matches.length !== 1) return { ok: false, reason: 'target_ambiguous' };

  try {
    return {
      ok: true,
      bindings: normalizeBotActorOwnerBindings(
        matches[0].botActorOwnerBindings,
        `Bot ${targetLarkAppId}.botActorOwnerBindings`,
      ),
    };
  } catch {
    return { ok: false, reason: 'bindings_invalid' };
  }
}
