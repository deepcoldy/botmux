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
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, cpSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { type Locale, SUPPORTED_LOCALES } from '../i18n/types.js';

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

export function customizationsRoot(): string {
  return join(config.session.dataDir, 'customizations');
}
function statePath(): string {
  return join(customizationsRoot(), 'state.json');
}
function skillsDir(): string {
  return join(customizationsRoot(), 'skills');
}
function skillOverridePath(name: string): string {
  return join(skillsDir(), `${safeSkillName(name)}.md`);
}
function historyDir(): string {
  return join(customizationsRoot(), 'history');
}
function historyIndexPath(): string {
  return join(historyDir(), 'index.json');
}
function snapshotDir(id: string): string {
  return join(historyDir(), safeSnapshotId(id));
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
let readCache: { at: number; state: CustomizationState } | undefined;

function ensureRoot(): void {
  mkdirSync(customizationsRoot(), { recursive: true });
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

/** Read the current state (short-TTL cached). Never throws — a missing or
 *  corrupt file yields the empty baseline. */
export function readCustomizationState(): CustomizationState {
  const now = Date.now();
  if (readCache && now - readCache.at < READ_CACHE_TTL_MS) return readCache.state;
  let state = emptyState();
  const fp = statePath();
  if (existsSync(fp)) {
    try { state = coerceState(JSON.parse(readFileSync(fp, 'utf-8'))); }
    catch { state = emptyState(); }
  }
  readCache = { at: now, state };
  return state;
}

export function invalidateCustomizationCache(): void {
  readCache = undefined;
}

function writeStateUnlocked(state: CustomizationState): void {
  ensureRoot();
  const next: CustomizationState = { ...state, schemaVersion: SCHEMA_VERSION, updatedAt: nowIso() };
  atomicWriteFileSync(statePath(), JSON.stringify(next, null, 2) + '\n');
  invalidateCustomizationCache();
}

function nowIso(): string {
  return new Date().toISOString();
}

function withStateLock<T>(fn: () => T): T {
  ensureRoot();
  return withFileLockSync(statePath(), fn, { maxWaitMs: LOCK_TIMEOUT_MS });
}

// ─── Master enabled flag ─────────────────────────────────────────────────────

/** Whether customizations are active. Missing flag = enabled (opt-out master
 *  switch); an explicit `false` disables everything. The resolution layer also
 *  consults this so a single check short-circuits all override lookups. */
export function customizationEnabled(): boolean {
  return readCustomizationState().enabled !== false;
}

// ─── Snapshot / history ──────────────────────────────────────────────────────

function readHistoryIndex(): HistoryIndex {
  const fp = historyIndexPath();
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

function writeHistoryIndex(index: HistoryIndex): void {
  mkdirSync(historyDir(), { recursive: true });
  atomicWriteFileSync(historyIndexPath(), JSON.stringify(index, null, 2) + '\n');
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
function snapshotCurrentUnlocked(label: string): CustomizationSnapshot {
  const current = existsSync(statePath()) ? readStateFromDisk() : emptyState();
  const id = `snap_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const dir = snapshotDir(id);
  mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(join(dir, 'state.json'), JSON.stringify(current, null, 2) + '\n');
  // Copy the skill override bodies so a rollback restores exact SKILL.md text,
  // not just the state.json pointers.
  if (existsSync(skillsDir())) {
    try { cpSync(skillsDir(), join(dir, 'skills'), { recursive: true }); } catch { /* best-effort */ }
  }
  const snap: CustomizationSnapshot = { id, at: nowIso(), label: label.slice(0, 200), summary: summarize(current) };
  const index = readHistoryIndex();
  index.snapshots.unshift(snap);
  // Prune oldest beyond the cap and delete their dirs.
  while (index.snapshots.length > MAX_SNAPSHOTS) {
    const dropped = index.snapshots.pop();
    if (dropped) { try { rmSync(snapshotDir(dropped.id), { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  writeHistoryIndex(index);
  return snap;
}

/** Uncached direct disk read — used inside locked sections where the TTL cache
 *  could be stale relative to a sibling process's just-committed write. */
function readStateFromDisk(): CustomizationState {
  const fp = statePath();
  if (!existsSync(fp)) return emptyState();
  try { return coerceState(JSON.parse(readFileSync(fp, 'utf-8'))); }
  catch { return emptyState(); }
}

export function listSnapshots(): CustomizationSnapshot[] {
  return readHistoryIndex().snapshots;
}

/** Read the full state stored in a snapshot (for diff preview before rollback). */
export function readSnapshotState(id: string): CustomizationState | undefined {
  const fp = join(snapshotDir(id), 'state.json');
  if (!existsSync(fp)) return undefined;
  try { return coerceState(JSON.parse(readFileSync(fp, 'utf-8'))); }
  catch { return undefined; }
}

/** Read a skill body as it existed in a snapshot (mirrors {@link readSkillOverrideBody}). */
export function readSnapshotSkillBody(id: string, name: string): string | undefined {
  const fp = join(snapshotDir(id), 'skills', `${safeSkillName(name)}.md`);
  if (!existsSync(fp)) return undefined;
  try { return readFileSync(fp, 'utf-8'); } catch { return undefined; }
}

// ─── Skill override bodies (stored as .md files, referenced by state) ─────────

/** Read the override SKILL.md body for a built-in skill, or undefined if none.
 *  Reads the .md file when the state entry has a body; the state's `body` field
 *  is a presence marker, the file is the source of truth for large text. */
export function readSkillOverrideBody(name: string): string | undefined {
  const fp = skillOverridePath(name);
  if (!existsSync(fp)) return undefined;
  try { return readFileSync(fp, 'utf-8'); } catch { return undefined; }
}

// ─── Mutations (each snapshots the prior state first) ─────────────────────────

/** Set (or clear) the master enabled flag. */
export function setCustomizationEnabled(enabled: boolean): CustomizationState {
  return withStateLock(() => {
    try { snapshotCurrentUnlocked(enabled ? 'enable customization' : 'disable customization'); } catch { /* best-effort */ }
    const state = readStateFromDisk();
    state.enabled = enabled;
    writeStateUnlocked(state);
    return state;
  });
}

/** Override (value set) or clear (value === null) a single prompt key for a locale. */
export function setPromptOverride(locale: Locale, key: string, value: string | null): CustomizationState {
  if (value !== null && Buffer.byteLength(value, 'utf-8') > MAX_PROMPT_OVERRIDE_BYTES) {
    throw new Error('prompt_override_too_large');
  }
  return withStateLock(() => {
    try { snapshotCurrentUnlocked(`${value === null ? 'reset' : 'set'} ${key} (${locale})`); } catch { /* best-effort */ }
    const state = readStateFromDisk();
    const po = state.promptOverrides ?? {};
    const map = { ...(po[locale] ?? {}) };
    if (value === null) delete map[key];
    else map[key] = value;
    if (Object.keys(map).length) po[locale] = map;
    else delete po[locale];
    if (Object.keys(po).length) state.promptOverrides = po;
    else delete state.promptOverrides;
    writeStateUnlocked(state);
    return state;
  });
}

/** Force a conditional prompt line on/off, or clear the override (follow shipped gating). */
export function setConditionalLine(key: string, value: boolean | null): CustomizationState {
  return withStateLock(() => {
    try { snapshotCurrentUnlocked(`${value === null ? 'reset' : 'set'} condition ${key}`); } catch { /* best-effort */ }
    const state = readStateFromDisk();
    const cl = { ...(state.conditionalLines ?? {}) };
    if (value === null) delete cl[key];
    else cl[key] = value;
    if (Object.keys(cl).length) state.conditionalLines = cl;
    else delete state.conditionalLines;
    writeStateUnlocked(state);
    return state;
  });
}

/** Set (body != null) or clear (body === null) the override body for a built-in skill.
 *  Clearing removes the body but leaves any `disabled` flag intact. */
export function setSkillOverrideBody(name: string, body: string | null): CustomizationState {
  const clean = safeSkillName(name);
  if (body !== null && Buffer.byteLength(body, 'utf-8') > MAX_SKILL_BODY_BYTES) {
    throw new Error('skill_body_too_large');
  }
  return withStateLock(() => {
    try { snapshotCurrentUnlocked(`${body === null ? 'reset body' : 'override body'} ${clean}`); } catch { /* best-effort */ }
    const state = readStateFromDisk();
    const bs = { ...(state.builtinSkills ?? {}) };
    const entry: BuiltinSkillOverride = { ...(bs[clean] ?? {}) };
    if (body === null) {
      delete entry.body;
      try { rmSync(skillOverridePath(clean), { force: true }); } catch { /* ignore */ }
    } else {
      entry.body = body;
      entry.updatedAt = nowIso();
      mkdirSync(skillsDir(), { recursive: true });
      atomicWriteFileSync(skillOverridePath(clean), body);
    }
    if (entry.body !== undefined || entry.disabled) bs[clean] = entry;
    else delete bs[clean];
    if (Object.keys(bs).length) state.builtinSkills = bs;
    else delete state.builtinSkills;
    writeStateUnlocked(state);
    return state;
  });
}

/** Enable/disable injection of a built-in skill (independent of any body override). */
export function setSkillDisabled(name: string, disabled: boolean): CustomizationState {
  const clean = safeSkillName(name);
  return withStateLock(() => {
    try { snapshotCurrentUnlocked(`${disabled ? 'disable' : 'enable'} skill ${clean}`); } catch { /* best-effort */ }
    const state = readStateFromDisk();
    const bs = { ...(state.builtinSkills ?? {}) };
    const entry: BuiltinSkillOverride = { ...(bs[clean] ?? {}) };
    if (disabled) entry.disabled = true;
    else delete entry.disabled;
    entry.updatedAt = nowIso();
    if (entry.body !== undefined || entry.disabled) bs[clean] = entry;
    else delete bs[clean];
    if (Object.keys(bs).length) state.builtinSkills = bs;
    else delete state.builtinSkills;
    writeStateUnlocked(state);
    return state;
  });
}

/** Reset EVERYTHING to factory: clears all overrides + skill bodies. Snapshots
 *  first, so this is fully reversible via rollback. Keeps the master enabled
 *  flag (resetting content is orthogonal to the on/off switch). */
export function resetAllToFactory(): CustomizationState {
  return withStateLock(() => {
    try { snapshotCurrentUnlocked('reset all to factory'); } catch { /* best-effort */ }
    const prior = readStateFromDisk();
    // Wipe the skill body files.
    try { rmSync(skillsDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    const next: CustomizationState = { schemaVersion: SCHEMA_VERSION };
    // Preserve the master switch across a content reset.
    if (prior.enabled !== undefined) next.enabled = prior.enabled;
    writeStateUnlocked(next);
    return next;
  });
}

/** Roll the current state back to a snapshot's contents. Non-destructive: the
 *  pre-rollback state is snapshotted first, so a rollback can itself be undone
 *  by rolling forward to that new snapshot. */
export function rollbackToSnapshot(id: string): CustomizationState {
  const target = readSnapshotState(id);
  if (!target) throw new Error('snapshot_not_found');
  return withStateLock(() => {
    try { snapshotCurrentUnlocked(`rollback to ${id}`); } catch { /* best-effort */ }
    // Restore skill bodies from the snapshot dir.
    try { rmSync(skillsDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    const snapSkills = join(snapshotDir(id), 'skills');
    if (existsSync(snapSkills)) {
      try { cpSync(snapSkills, skillsDir(), { recursive: true }); } catch { /* best-effort */ }
    }
    writeStateUnlocked(target);
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
): CustomizationState {
  return withStateLock(() => {
    try { snapshotCurrentUnlocked(label); } catch { /* best-effort */ }
    const clean = coerceState(next);
    // Rewrite skill body files to exactly match the incoming set.
    try { rmSync(skillsDir(), { recursive: true, force: true }); } catch { /* ignore */ }
    if (clean.builtinSkills) {
      mkdirSync(skillsDir(), { recursive: true });
      for (const [name, entry] of Object.entries(clean.builtinSkills)) {
        if (entry.body === undefined) continue;
        const body = skillBodies[name];
        if (typeof body === 'string') {
          atomicWriteFileSync(skillOverridePath(name), body);
        } else {
          // Body marked present but no text supplied — drop the marker so state
          // never references a missing file.
          delete entry.body;
          if (entry.body === undefined && !entry.disabled) delete clean.builtinSkills[name];
        }
      }
      if (clean.builtinSkills && !Object.keys(clean.builtinSkills).length) delete clean.builtinSkills;
    }
    writeStateUnlocked(clean);
    return clean;
  });
}
