/**
 * Customization store — user overrides for botmux's BUILT-IN prompts and skills.
 *
 * botmux ships two kinds of built-in content the model sees every session:
 *   - **Prompt fragments** — the `<botmux_routing>` / `<identity>` / skill-catalog
 *     copy, all resolved through the i18n `t(key, …, locale)` layer.
 *   - **Built-in skills** — the SKILL.md bodies in `src/skills/definitions.ts`.
 *
 * This store lets the user OVERRIDE either without editing shipped source, and
 * SHARE the result. It is the single source of truth for:
 *   - per-locale prompt-key overrides (`t()` consults these first)
 *   - built-in skill body overrides + per-skill disables
 *   - a master on/off flag (disable everything without deleting it)
 *   - a snapshot history for non-destructive rollback / reset-to-factory
 *
 * DESIGN INVARIANTS
 *   1. **Byte-identical when empty.** With no overrides (or master off) every
 *      resolver here returns `undefined` / the shipped default, so the prompt
 *      and skills are byte-for-byte what they were before this feature. The
 *      resolution layer (i18n `t()`, injection-mode, installer) short-circuits
 *      on `undefined`. This is the first regression red line.
 *   2. **Non-destructive history.** Every mutation snapshots the *prior* state
 *      first, so rollback and "reset all to factory" can always be undone by
 *      rolling forward to a later snapshot — nothing is ever lost.
 *   3. **Live.** State is read fresh (short TTL cache) so a change takes effect
 *      on the next session with no daemon restart, matching whiteboard /
 *      skillInjection semantics.
 *
 * Storage layout under `{dataDir}/customizations/`:
 *   state.json                     — the current CustomizationState (overrides + flags)
 *   skills/<name>.md               — full SKILL.md body for an overridden built-in skill
 *   history/<snapshotId>/state.json + skills/*.md  — a full point-in-time copy
 *   history/index.json             — ordered snapshot metadata (newest first)
 *
 * The master enabled flag also mirrors into GlobalConfig (`customization.enabled`)
 * so it participates in the dashboard settings surface; this store owns the rest.
 *
 * SCOPES (services/customization-scope.ts): the layout above exists once per
 * scope — `customizations/` (feishu, what every scope-less caller gets, exactly
 * as before scopes existed) and `customizations-wecom/` (the native-gateway
 * channel). Every exported function takes the scope as an optional LAST
 * argument. The read cache, the file lock and the history are per store root,
 * so two scopes used alternately in one process (the Dashboard) never mix.
 *
 * READ-ONLY IN A NATIVE GATEWAY CORE: a native gateway's dedicated core (and
 * its workers) only ever reads a store — the one its gateway hands it, see
 * skills/effective-builtins.ts — so every mutation refuses there, and in the
 * CLI sessions of that core (core/native-gateway-session.ts).
 */
import {
  existsSync, mkdirSync, readFileSync, rmSync, cpSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { type Locale, SUPPORTED_LOCALES } from '../i18n/types.js';
import { isNativeGatewayCoreProcess } from '../core/runtime-mode.js';
import { inNativeGatewaySession } from '../core/native-gateway-session.js';
import {
  type CustomizationScope,
  DEFAULT_CUSTOMIZATION_SCOPE,
  customizationStoreRoot,
  customizationScopeHasSkills,
  wecomCustomizationStoreDir,
} from './customization-scope.js';

export {
  type CustomizationScope,
  CUSTOMIZATION_SCOPES,
  DEFAULT_CUSTOMIZATION_SCOPE,
  isCustomizationScope,
  customizationStoreRoot,
  customizationScopeHasSkills,
  wecomCustomizationStoreDir,
} from './customization-scope.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** One overridden built-in skill: a replacement body, and/or a disable flag.
 *  `body === undefined` + `disabled` = keep shipped body but never inject it.
 *  `body` set = inject this instead of the shipped SKILL.md. */
export interface BuiltinSkillOverride {
  /** Full replacement SKILL.md (frontmatter + body). Omitted = use shipped body. */
  body?: string;
  /** When true the skill is not injected at all (catalog + files both skip it). */
  disabled?: boolean;
  /** ISO timestamp of the last edit to this entry (for history diffs / UI). */
  updatedAt?: string;
}

/** The full current customization state. Everything is optional so an empty
 *  object is the valid "no customization" baseline. */
export interface CustomizationState {
  schemaVersion: 1;
  /** Master switch. `false` = all overrides ignored (byte-identical baseline)
   *  but retained on disk. Missing is treated as enabled (see {@link customizationEnabled}). */
  enabled?: boolean;
  /** Prompt-key overrides, keyed by locale then i18n key. A value replaces the
   *  shipped `t(key)` string for that locale. */
  promptOverrides?: Partial<Record<Locale, Record<string, string>>>;
  /** Conditional prompt lines forced on/off by the i18n key that renders them
   *  (e.g. `ai.routing.no_visible_output_ok`). Absent = follow the shipped
   *  gating logic; present = force that boolean regardless. */
  conditionalLines?: Record<string, boolean>;
  /** Built-in skill overrides keyed by skill name (e.g. `botmux-send`). */
  builtinSkills?: Record<string, BuiltinSkillOverride>;
  /** Last-modified ISO timestamp of the state as a whole. */
  updatedAt?: string;
}

/** Metadata for one point-in-time snapshot in the history log. */
export interface CustomizationSnapshot {
  id: string;
  /** ISO time the snapshot was taken (i.e. when the *prior* state was captured). */
  at: string;
  /** Short human label describing the mutation that triggered this snapshot,
   *  e.g. "set ai.routing.intro (zh)" / "reset all to factory" / "import bundle". */
  label: string;
  /** Coarse counts of the snapshotted state, for a quick history-list summary. */
  summary: { promptKeys: number; skills: number; enabled: boolean };
}

interface HistoryIndex {
  schemaVersion: 1;
  /** Newest-first. */
  snapshots: CustomizationSnapshot[];
}

// ─── Paths ───────────────────────────────────────────────────────────────────

const SCHEMA_VERSION = 1 as const;
/** Cap retained snapshots so an active editor can't grow history unbounded. */
const MAX_SNAPSHOTS = 50;
/** Per-skill body cap — mirrors the spirit of role-resolver's MAX_ROLE_BYTES. */
export const MAX_SKILL_BODY_BYTES = 64 * 1024;
/** Per prompt-override value cap. Individual fragments are short; this is a
 *  generous ceiling that still stops a paste-bomb from bloating every prompt. */
export const MAX_PROMPT_OVERRIDE_BYTES = 16 * 1024;

/** Root of `scope`'s store: the Feishu one under this process's data dir
 *  (exactly as before scopes existed), the WeCom one by its single resolution
 *  rule (customization-scope.ts wecomCustomizationStoreDir). */
export function customizationsRoot(scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): string {
  return scope === 'wecom' ? wecomCustomizationStoreDir() : customizationStoreRoot(config.session.dataDir, scope);
}
function statePath(root: string): string {
  return join(root, 'state.json');
}
function skillsDir(root: string): string {
  return join(root, 'skills');
}
function skillOverridePath(root: string, name: string): string {
  return join(skillsDir(root), `${safeSkillName(name)}.md`);
}
function historyDir(root: string): string {
  return join(root, 'history');
}
function historyIndexPath(root: string): string {
  return join(historyDir(root), 'index.json');
}
function snapshotDir(root: string, id: string): string {
  return join(historyDir(root), safeSnapshotId(id));
}

// ─── Validation helpers ──────────────────────────────────────────────────────

/** Built-in skill names are the fixed `botmux-*` set; this guards path building
 *  against traversal even though callers pass known names. */
function safeSkillName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('invalid_skill_name');
  return name;
}
function safeSnapshotId(id: string): string {
  if (!/^snap_[a-zA-Z0-9]{1,40}$/.test(id)) throw new Error('invalid_snapshot_id');
  return id;
}
function isLocaleKey(v: string): v is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

// ─── State read/write ────────────────────────────────────────────────────────

const LOCK_TIMEOUT_MS = 5_000;
// Short TTL so dashboard/CLI writes are picked up by the next session without a
// restart, but hot prompt-build paths don't re-parse the file on every t() call.
const READ_CACHE_TTL_MS = 2_000;
/** Per store root, so scopes (and explicit roots) never share an entry. */
const readCache = new Map<string, { at: number; state: CustomizationState }>();

function ensureRoot(root: string): void {
  mkdirSync(root, { recursive: true });
}

function emptyState(): CustomizationState {
  return { schemaVersion: SCHEMA_VERSION };
}

/** Coerce arbitrary parsed JSON into a valid CustomizationState, dropping
 *  anything malformed (same defensive spirit as global-config's readX). */
function coerceState(raw: unknown): CustomizationState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const r = raw as Record<string, unknown>;
  const out: CustomizationState = { schemaVersion: SCHEMA_VERSION };
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.updatedAt === 'string') out.updatedAt = r.updatedAt;

  if (r.promptOverrides && typeof r.promptOverrides === 'object') {
    const po: Partial<Record<Locale, Record<string, string>>> = {};
    for (const [loc, map] of Object.entries(r.promptOverrides as Record<string, unknown>)) {
      if (!isLocaleKey(loc) || !map || typeof map !== 'object') continue;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
        if (typeof v === 'string' && k) clean[k] = v;
      }
      if (Object.keys(clean).length) po[loc] = clean;
    }
    if (Object.keys(po).length) out.promptOverrides = po;
  }

  if (r.conditionalLines && typeof r.conditionalLines === 'object') {
    const cl: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(r.conditionalLines as Record<string, unknown>)) {
      if (typeof v === 'boolean' && k) cl[k] = v;
    }
    if (Object.keys(cl).length) out.conditionalLines = cl;
  }

  if (r.builtinSkills && typeof r.builtinSkills === 'object') {
    const bs: Record<string, BuiltinSkillOverride> = {};
    for (const [name, ov] of Object.entries(r.builtinSkills as Record<string, unknown>)) {
      if (!ov || typeof ov !== 'object') continue;
      const o = ov as Record<string, unknown>;
      const entry: BuiltinSkillOverride = {};
      if (typeof o.body === 'string') entry.body = o.body;
      if (o.disabled === true) entry.disabled = true;
      if (typeof o.updatedAt === 'string') entry.updatedAt = o.updatedAt;
      // Skip no-op entries (neither a body nor a disable) so an empty override
      // never counts as "modified".
      if (entry.body !== undefined || entry.disabled) bs[name] = entry;
    }
    if (Object.keys(bs).length) out.builtinSkills = bs;
  }

  return out;
}

/** Read the current state of `scope` (short-TTL cached). Never throws — a
 *  missing or corrupt file yields the empty baseline. */
export function readCustomizationState(scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): CustomizationState {
  return readCustomizationStateAt(customizationsRoot(scope));
}

/**
 * Read the state of the store rooted at `root` (an absolute store directory,
 * e.g. the one a native gateway hands its core). Same cache, same never-throw
 * contract as {@link readCustomizationState}. There is no write counterpart:
 * a store addressed by an explicit root is only ever read.
 */
export function readCustomizationStateAt(root: string): CustomizationState {
  const now = Date.now();
  const cached = readCache.get(root);
  if (cached && now - cached.at < READ_CACHE_TTL_MS) return cached.state;
  let state = emptyState();
  const fp = statePath(root);
  if (existsSync(fp)) {
    try { state = coerceState(JSON.parse(readFileSync(fp, 'utf-8'))); }
    catch { state = emptyState(); }
  }
  readCache.set(root, { at: now, state });
  return state;
}

/** Drop every cached read (all scopes / roots). */
export function invalidateCustomizationCache(): void {
  readCache.clear();
}

function writeStateUnlocked(root: string, state: CustomizationState): void {
  ensureRoot(root);
  const next: CustomizationState = { ...state, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso() };
  atomicWriteFileSync(statePath(root), JSON.stringify(next, null, 2) + '\n');
  readCache.delete(root);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Thrown by every mutation inside a native gateway's dedicated core. */
export const CUSTOMIZATION_STORE_READ_ONLY = 'customization_store_read_only';
/** Thrown by skill mutations on a scope without built-in skills. */
export const CUSTOMIZATION_SCOPE_HAS_NO_SKILLS = 'skills_not_supported_in_scope';

function assertWritable(): void {
  // The core and its workers carry the native mark; its CLI sessions do not,
  // but they see the core's marked store (core/native-gateway-session.ts).
  if (isNativeGatewayCoreProcess() || inNativeGatewaySession()) throw new Error(CUSTOMIZATION_STORE_READ_ONLY);
}

function assertSkillsScope(scope: CustomizationScope): void {
  if (!customizationScopeHasSkills(scope)) throw new Error(CUSTOMIZATION_SCOPE_HAS_NO_SKILLS);
}

function withStateLock<T>(root: string, fn: () => T): T {
  assertWritable();
  ensureRoot(root);
  return withFileLockSync(statePath(root), fn, { maxWaitMs: LOCK_TIMEOUT_MS });
}

// ─── Master enabled flag ─────────────────────────────────────────────────────

/** Whether customizations are active. Missing flag = enabled (opt-out master
 *  switch); an explicit `false` disables everything. The resolution layer also
 *  consults this so a single check short-circuits all override lookups. */
export function customizationEnabled(scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): boolean {
  return readCustomizationState(scope).enabled !== false;
}

// ─── Snapshot / history ──────────────────────────────────────────────────────

function readHistoryIndex(root: string): HistoryIndex {
  const fp = historyIndexPath(root);
  if (!existsSync(fp)) return { schemaVersion: SCHEMA_VERSION, snapshots: [] };
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as Partial<HistoryIndex>;
    return {
      schemaVersion: SCHEMA_VERSION,
      snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots as CustomizationSnapshot[] : [],
    };
  } catch {
    return { schemaVersion: SCHEMA_VERSION, snapshots: [] };
  }
}

function writeHistoryIndex(root: string, index: HistoryIndex): void {
  mkdirSync(historyDir(root), { recursive: true });
  atomicWriteFileSync(historyIndexPath(root), JSON.stringify(index, null, 2) + '\n');
}

function summarize(state: CustomizationState): CustomizationSnapshot['summary'] {
  const promptKeys = Object.values(state.promptOverrides ?? {})
    .reduce((n, m) => n + Object.keys(m ?? {}).length, 0)
    + Object.keys(state.conditionalLines ?? {}).length;
  const skills = Object.keys(state.builtinSkills ?? {}).length;
  return { promptKeys, skills, enabled: state.enabled !== false };
}

/** Capture the CURRENT on-disk state (+ its skill bodies) as a new snapshot.
 *  Must be called *before* a mutation writes the new state, so the snapshot
 *  preserves the prior point-in-time. Prunes to MAX_SNAPSHOTS. Best-effort:
 *  a snapshot failure never blocks the mutation itself (caller ignores throw). */
function snapshotCurrentUnlocked(root: string, label: string): CustomizationSnapshot {
  const current = existsSync(statePath(root)) ? readStateFromDisk(root) : emptyState();
  const id = `snap_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const dir = snapshotDir(root, id);
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, 'state.json'), JSON.stringify(current, null, 2) + '\n');
  // Copy the skill override bodies so a rollback restores exact SKILL.md text,
  // not just the state.json pointers.
  if (existsSync(skillsDir(root))) {
    try { cpSync(skillsDir(root), join(dir, 'skills'), { recursive: true }); } catch { /* best-effort */ }
  }
  const snap: CustomizationSnapshot = { id, at: nowIso(), label: label.slice(0, 200), summary: summarize(current) };
  const index = readHistoryIndex(root);
  index.snapshots.unshift(snap);
  // Prune oldest beyond the cap and delete their dirs.
  while (index.snapshots.length > MAX_SNAPSHOTS) {
    const dropped = index.snapshots.pop();
    if (dropped) { try { rmSync(snapshotDir(root, dropped.id), { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  writeHistoryIndex(root, index);
  return snap;
}

/** Uncached direct disk read — used inside locked sections where the TTL cache
 *  could be stale relative to a sibling process's just-committed write. */
function readStateFromDisk(root: string): CustomizationState {
  const fp = statePath(root);
  if (!existsSync(fp)) return emptyState();
  try { return coerceState(JSON.parse(readFileSync(fp, 'utf-8'))); }
  catch { return emptyState(); }
}

export function listSnapshots(scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): CustomizationSnapshot[] {
  return readHistoryIndex(customizationsRoot(scope)).snapshots;
}

/** Read the full state stored in a snapshot (for diff preview before rollback). */
export function readSnapshotState(id: string, scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): CustomizationState | undefined {
  const fp = join(snapshotDir(customizationsRoot(scope), id), 'state.json');
  if (!existsSync(fp)) return undefined;
  try { return coerceState(JSON.parse(readFileSync(fp, 'utf-8'))); }
  catch { return undefined; }
}

/** Read a skill body as it existed in a snapshot (mirrors {@link readSkillOverrideBody}). */
export function readSnapshotSkillBody(id: string, name: string, scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): string | undefined {
  const fp = join(snapshotDir(customizationsRoot(scope), id), 'skills', `${safeSkillName(name)}.md`);
  if (!existsSync(fp)) return undefined;
  try { return readFileSync(fp, 'utf-8'); } catch { return undefined; }
}

// ─── Skill override bodies (stored as .md files, referenced by state) ─────────

/** Read the override SKILL.md body for a built-in skill, or undefined if none.
 *  Reads the .md file when the state entry has a body; the state's `body` field
 *  is a presence marker, the file is the source of truth for large text. */
export function readSkillOverrideBody(name: string, scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): string | undefined {
  return readSkillOverrideBodyAt(customizationsRoot(scope), name);
}

/** {@link readSkillOverrideBody} for the store rooted at `root` (read-only, like {@link readCustomizationStateAt}). */
export function readSkillOverrideBodyAt(root: string, name: string): string | undefined {
  const fp = skillOverridePath(root, name);
  if (!existsSync(fp)) return undefined;
  try { return readFileSync(fp, 'utf-8'); } catch { return undefined; }
}

// ─── Mutations (each snapshots the prior state first) ─────────────────────────

/** Set (or clear) the master enabled flag. */
export function setCustomizationEnabled(enabled: boolean, scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): CustomizationState {
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, enabled ? 'enable customization' : 'disable customization'); } catch { /* best-effort */ }
    const state = readStateFromDisk(root);
    state.enabled = enabled;
    writeStateUnlocked(root, state);
    return state;
  });
}

/** Override (value set) or clear (value === null) a single prompt key for a locale. */
export function setPromptOverride(
  locale: Locale,
  key: string,
  value: string | null,
  scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE,
): CustomizationState {
  if (value !== null && Buffer.byteLength(value, 'utf-8') > MAX_PROMPT_OVERRIDE_BYTES) {
    throw new Error('prompt_override_too_large');
  }
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, `${value === null ? 'reset' : 'set'} ${key} (${locale})`); } catch { /* best-effort */ }
    const state = readStateFromDisk(root);
    const po = state.promptOverrides ?? {};
    const map = { ...(po[locale] ?? {}) };
    if (value === null) delete map[key];
    else map[key] = value;
    if (Object.keys(map).length) po[locale] = map;
    else delete po[locale];
    if (Object.keys(po).length) state.promptOverrides = po;
    else delete state.promptOverrides;
    writeStateUnlocked(root, state);
    return state;
  });
}

/** Force a conditional prompt line on/off, or clear the override (follow shipped gating). */
export function setConditionalLine(
  key: string,
  value: boolean | null,
  scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE,
): CustomizationState {
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, `${value === null ? 'reset' : 'set'} condition ${key}`); } catch { /* best-effort */ }
    const state = readStateFromDisk(root);
    const cl = { ...(state.conditionalLines ?? {}) };
    if (value === null) delete cl[key];
    else cl[key] = value;
    if (Object.keys(cl).length) state.conditionalLines = cl;
    else delete state.conditionalLines;
    writeStateUnlocked(root, state);
    return state;
  });
}

/** Set (body != null) or clear (body === null) the override body for a built-in skill.
 *  Clearing removes the body but leaves any `disabled` flag intact. */
export function setSkillOverrideBody(
  name: string,
  body: string | null,
  scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE,
): CustomizationState {
  const clean = safeSkillName(name);
  if (body !== null && Buffer.byteLength(body, 'utf-8') > MAX_SKILL_BODY_BYTES) {
    throw new Error('skill_body_too_large');
  }
  assertSkillsScope(scope);
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, `${body === null ? 'reset body' : 'override body'} ${clean}`); } catch { /* best-effort */ }
    const state = readStateFromDisk(root);
    const bs = { ...(state.builtinSkills ?? {}) };
    const entry: BuiltinSkillOverride = { ...(bs[clean] ?? {}) };
    if (body === null) {
      delete entry.body;
      try { rmSync(skillOverridePath(root, clean), { force: true }); } catch { /* ignore */ }
    } else {
      entry.body = body;
      entry.updatedAt = nowIso();
      mkdirSync(skillsDir(root), { recursive: true });
      atomicWriteFileSync(skillOverridePath(root, clean), body);
    }
    if (entry.body !== undefined || entry.disabled) bs[clean] = entry;
    else delete bs[clean];
    if (Object.keys(bs).length) state.builtinSkills = bs;
    else delete state.builtinSkills;
    writeStateUnlocked(root, state);
    return state;
  });
}

/** Enable/disable injection of a built-in skill (independent of any body override). */
export function setSkillDisabled(
  name: string,
  disabled: boolean,
  scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE,
): CustomizationState {
  const clean = safeSkillName(name);
  assertSkillsScope(scope);
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, `${disabled ? 'disable' : 'enable'} skill ${clean}`); } catch { /* best-effort */ }
    const state = readStateFromDisk(root);
    const bs = { ...(state.builtinSkills ?? {}) };
    const entry: BuiltinSkillOverride = { ...(bs[clean] ?? {}) };
    if (disabled) entry.disabled = true;
    else delete entry.disabled;
    entry.updatedAt = nowIso();
    if (entry.body !== undefined || entry.disabled) bs[clean] = entry;
    else delete bs[clean];
    if (Object.keys(bs).length) state.builtinSkills = bs;
    else delete state.builtinSkills;
    writeStateUnlocked(root, state);
    return state;
  });
}

/** Reset EVERYTHING to factory: clears all overrides + skill bodies. Snapshots
 *  first, so this is fully reversible via rollback. Keeps the master enabled
 *  flag (resetting content is orthogonal to the on/off switch). */
export function resetAllToFactory(scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): CustomizationState {
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, 'reset all to factory'); } catch { /* best-effort */ }
    const prior = readStateFromDisk(root);
    // Wipe the skill body files.
    try { rmSync(skillsDir(root), { recursive: true, force: true }); } catch { /* ignore */ }
    const next: CustomizationState = { schemaVersion: SCHEMA_VERSION };
    // Preserve the master switch across a content reset.
    if (prior.enabled !== undefined) next.enabled = prior.enabled;
    writeStateUnlocked(root, next);
    return next;
  });
}

/** Roll the current state back to a snapshot's contents. Non-destructive: the
 *  pre-rollback state is snapshotted first, so a rollback can itself be undone
 *  by rolling forward to that new snapshot. */
export function rollbackToSnapshot(id: string, scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE): CustomizationState {
  const target = readSnapshotState(id, scope);
  if (!target) throw new Error('snapshot_not_found');
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, `rollback to ${id}`); } catch { /* best-effort */ }
    // Restore skill bodies from the snapshot dir.
    try { rmSync(skillsDir(root), { recursive: true, force: true }); } catch { /* ignore */ }
    const snapSkills = join(snapshotDir(root, id), 'skills');
    if (existsSync(snapSkills)) {
      try { cpSync(snapSkills, skillsDir(root), { recursive: true }); } catch { /* best-effort */ }
    }
    writeStateUnlocked(root, target);
    return target;
  });
}

/** Replace the entire state atomically (used by bundle import after diff
 *  confirmation). Snapshots first. `skillBodies` maps skill name → SKILL.md so
 *  the .md files are materialised alongside the state pointers. */
export function replaceState(
  next: CustomizationState,
  skillBodies: Record<string, string>,
  label: string,
  scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE,
): CustomizationState {
  if (next.builtinSkills && Object.keys(next.builtinSkills).length) assertSkillsScope(scope);
  const root = customizationsRoot(scope);
  return withStateLock(root, () => {
    try { snapshotCurrentUnlocked(root, label); } catch { /* best-effort */ }
    const clean = coerceState(next);
    // Rewrite skill body files to exactly match the incoming set.
    try { rmSync(skillsDir(root), { recursive: true, force: true }); } catch { /* ignore */ }
    if (clean.builtinSkills) {
      mkdirSync(skillsDir(root), { recursive: true });
      for (const [name, entry] of Object.entries(clean.builtinSkills)) {
        if (entry.body === undefined) continue;
        const body = skillBodies[name];
        if (typeof body === 'string') {
          atomicWriteFileSync(skillOverridePath(root, name), body);
        } else {
          // Body marked present but no text supplied — drop the marker so state
          // never references a missing file.
          delete entry.body;
          if (entry.body === undefined && !entry.disabled) delete clean.builtinSkills[name];
        }
      }
      if (clean.builtinSkills && !Object.keys(clean.builtinSkills).length) delete clean.builtinSkills;
    }
    writeStateUnlocked(root, clean);
    return clean;
  });
}
