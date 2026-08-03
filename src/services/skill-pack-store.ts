import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { skillPackRegistryPath } from '../core/skills/registry-paths.js';
import type { SkillPack, SkillPackRegistryFile } from '../core/skills/types.js';

const MAX_NAME_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 40;
const MAX_INCLUDE = 100;

export interface SkillPackInput {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  include: Array<`skill:${string}`>;
}

export interface SkillPackUpdateInput {
  name?: string;
  description?: string | null;
  tags?: string[] | null;
  include?: Array<`skill:${string}`>;
  /** Expected current revision; if it does not match, the update is rejected
   *  with `SKILL_PACK_REVISION_CONFLICT` so two dashboard tabs cannot silently
   *  overwrite each other. */
  expectedRevision?: number;
}

export type SkillPackStoreErrorDetail =
  | { code: 'SKILL_PACK_NOT_FOUND'; id: string }
  | { code: 'SKILL_PACK_ID_CONFLICT'; id: string }
  | { code: 'SKILL_PACK_INVALID_SELECTOR'; selector: string }
  | { code: 'SKILL_PACK_INVALID'; reason: string }
  | { code: 'SKILL_PACK_REVISION_CONFLICT'; id: string; current: number }
  | { code: 'SKILL_PACK_IN_USE'; id: string };

export class SkillPackStoreError extends Error {
  constructor(public readonly detail: SkillPackStoreErrorDetail) {
    super(detail.code);
    this.name = 'SkillPackStoreError';
  }
}

function emptyRegistry(): SkillPackRegistryFile {
  return { schemaVersion: 1, packs: {} };
}

export function readSkillPackRegistry(): SkillPackRegistryFile {
  const file = skillPackRegistryPath();
  if (!existsSync(file)) return emptyRegistry();
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    const packs = parsed?.packs && typeof parsed.packs === 'object' && !Array.isArray(parsed.packs)
      ? parsed.packs
      : {};
    return { schemaVersion: 1, packs: packs as Record<string, SkillPack> };
  } catch {
    // A corrupt packs.json must not take down the whole skill pipeline; treat
    // it as empty so bots keep working (packs simply resolve to nothing).
    return emptyRegistry();
  }
}

function writeSkillPackRegistry(registry: SkillPackRegistryFile): void {
  mkdirSync(dirname(skillPackRegistryPath()), { recursive: true });
  atomicWriteFileSync(skillPackRegistryPath(), JSON.stringify(registry, null, 2) + '\n', { mode: 0o600 });
}

function isSkillSelector(value: unknown): value is `skill:${string}` {
  return typeof value === 'string' && /^skill:.+$/.test(value);
}

function normalizeInclude(raw: unknown): Array<`skill:${string}`> {
  if (!Array.isArray(raw)) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'include must be an array' });
  const seen = new Set<string>();
  const out: Array<`skill:${string}`> = [];
  for (const item of raw) {
    if (!isSkillSelector(item)) {
      throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID_SELECTOR', selector: String(item) });
    }
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  if (out.length === 0) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'include must contain at least one skill' });
  if (out.length > MAX_INCLUDE) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: `include exceeds ${MAX_INCLUDE} skills` });
  return out;
}

function normalizeTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'tags must be an array' });
  const out: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== 'string') throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'tags must be strings' });
    const trimmed = tag.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_TAG_LENGTH) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: `tag exceeds ${MAX_TAG_LENGTH} chars` });
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  if (out.length > MAX_TAGS) throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: `tags exceed ${MAX_TAGS}` });
  return out.length > 0 ? out : undefined;
}

function validateId(id: unknown): string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'id must be a lowercase slug (a-z, 0-9, -)' });
  }
  return id;
}

function validateName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'name is required' });
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: `name exceeds ${MAX_NAME_LENGTH} chars` });
  }
  return trimmed;
}

function validateDescription(description: unknown): string | undefined {
  if (description === undefined || description === null) return undefined;
  if (typeof description !== 'string') {
    throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: 'description must be a string' });
  }
  const trimmed = description.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    throw new SkillPackStoreError({ code: 'SKILL_PACK_INVALID', reason: `description exceeds ${MAX_DESCRIPTION_LENGTH} chars` });
  }
  return trimmed;
}

export function listSkillPacks(): SkillPack[] {
  return Object.values(readSkillPackRegistry().packs).sort((a, b) => a.name.localeCompare(b.name));
}

export function getSkillPack(id: string): SkillPack | undefined {
  return readSkillPackRegistry().packs[id];
}

export function createSkillPack(input: SkillPackInput): SkillPack {
  const id = validateId(input.id);
  const registry = readSkillPackRegistry();
  if (registry.packs[id]) {
    throw new SkillPackStoreError({ code: 'SKILL_PACK_ID_CONFLICT', id });
  }
  const now = new Date().toISOString();
  const pack: SkillPack = {
    id,
    name: validateName(input.name),
    description: validateDescription(input.description),
    tags: normalizeTags(input.tags),
    include: normalizeInclude(input.include),
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  registry.packs[id] = pack;
  writeSkillPackRegistry(registry);
  return pack;
}

export function updateSkillPack(id: string, input: SkillPackUpdateInput): SkillPack {
  const registry = readSkillPackRegistry();
  const existing = registry.packs[id];
  if (!existing) throw new SkillPackStoreError({ code: 'SKILL_PACK_NOT_FOUND', id });
  if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    throw new SkillPackStoreError({ code: 'SKILL_PACK_REVISION_CONFLICT', id, current: existing.revision });
  }
  const updated: SkillPack = {
    ...existing,
    name: input.name !== undefined ? validateName(input.name) : existing.name,
    description: input.description !== undefined ? validateDescription(input.description) : existing.description,
    tags: input.tags !== undefined ? normalizeTags(input.tags) : existing.tags,
    include: input.include !== undefined ? normalizeInclude(input.include) : existing.include,
    revision: existing.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  registry.packs[id] = updated;
  writeSkillPackRegistry(registry);
  return updated;
}

export function deleteSkillPack(id: string): void {
  const registry = readSkillPackRegistry();
  if (!registry.packs[id]) throw new SkillPackStoreError({ code: 'SKILL_PACK_NOT_FOUND', id });
  delete registry.packs[id];
  writeSkillPackRegistry(registry);
}

export function cloneSkillPack(id: string, newId: string): SkillPack {
  const source = getSkillPack(id);
  if (!source) throw new SkillPackStoreError({ code: 'SKILL_PACK_NOT_FOUND', id });
  return createSkillPack({
    id: newId,
    name: `${source.name} (copy)`,
    description: source.description,
    tags: source.tags,
    include: source.include,
  });
}
