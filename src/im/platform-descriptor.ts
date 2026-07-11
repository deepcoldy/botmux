/**
 * Backward-compatible identity fields shared by daemon descriptor readers.
 *
 * Descriptor files historically exposed only `larkAppId`. New writers may
 * additionally publish a platform-neutral identity. Readers normalize both
 * shapes without rewriting the descriptor on disk:
 *
 *   legacy:  { larkAppId }                    -> lark / larkAppId
 *   generic: { platform, instanceId, ... }    -> explicit fields win
 *
 * `larkAppId` remains populated as a compatibility alias. A future non-Lark
 * descriptor that omits it receives `instanceId` as the alias so existing
 * wire consumers keep a stable string while platform-aware consumers use the
 * `(platform, instanceId)` pair.
 */

export interface DescriptorPlatformRef {
  platform: string;
  instanceId: string;
}

export type DescriptorCapabilities = Readonly<Record<string, boolean>>;

export interface NormalizedPlatformDescriptor extends DescriptorPlatformRef {
  /** Legacy compatibility identity. Prefer `platform` + `instanceId`. */
  larkAppId: string;
  capabilities?: DescriptorCapabilities;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeCapabilities(value: unknown): DescriptorCapabilities | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const normalized: Record<string, boolean> = {};
  for (const [key, enabled] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || typeof enabled !== 'boolean') return null;
    normalized[normalizedKey] = enabled;
  }
  return normalized;
}

/**
 * Normalize only the shared platform portion of a descriptor. Callers remain
 * responsible for validating their own required transport/runtime fields.
 */
export function normalizePlatformDescriptor(raw: unknown): NormalizedPlatformDescriptor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const hasLegacyId = Object.prototype.hasOwnProperty.call(record, 'larkAppId');
  const legacyId = hasLegacyId ? nonEmptyString(record.larkAppId) : null;
  if (hasLegacyId && !legacyId) return null;

  const hasPlatform = Object.prototype.hasOwnProperty.call(record, 'platform');
  const hasInstanceId = Object.prototype.hasOwnProperty.call(record, 'instanceId');
  let platform: string;
  let instanceId: string;
  if (hasPlatform || hasInstanceId) {
    // Generic descriptors are atomic: accepting half of the pair could combine
    // a future platform with the legacy Lark id and create a split identity.
    if (!hasPlatform || !hasInstanceId) return null;
    const genericPlatform = nonEmptyString(record.platform);
    const genericInstanceId = nonEmptyString(record.instanceId);
    if (!genericPlatform || !genericInstanceId) return null;
    platform = genericPlatform;
    instanceId = genericInstanceId;
  } else {
    if (!legacyId) return null;
    platform = 'lark';
    instanceId = legacyId;
  }
  if (platform === 'lark' && legacyId && legacyId !== instanceId) return null;

  const capabilities = normalizeCapabilities(record.capabilities);
  if (capabilities === null) return null;

  return {
    platform,
    instanceId,
    larkAppId: legacyId ?? instanceId,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

/** Collision-free structured key for an opaque platform instance pair. */
export function platformDescriptorKey(ref: DescriptorPlatformRef): string {
  return JSON.stringify([ref.platform, ref.instanceId]);
}
