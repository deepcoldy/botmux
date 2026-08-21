/**
 * Customization bundle — a self-contained, portable snapshot of a user's
 * built-in prompt + skill overrides, for sharing between botmux installs.
 *
 * Unlike skill "packs" (which are just name references and need the target to
 * already have those skills), a bundle INLINES everything: full prompt-override
 * strings per locale, full SKILL.md bodies, and disable flags. A bundle JSON is
 * therefore portable on its own — the recipient imports it with no dependency
 * on the author's environment.
 *
 * Export reads the live {@link customization-store} state + skill bodies.
 * Import validates the bundle, computes a human-readable diff against current
 * state (for a confirm-before-apply preview), and — only on confirmation —
 * calls {@link replaceState} to materialise it.
 */
import type { Locale } from '../i18n/types.js';
import { SUPPORTED_LOCALES } from '../i18n/types.js';
import {
  readCustomizationState,
  readSkillOverrideBody,
  replaceState,
  type CustomizationState,
  MAX_SKILL_BODY_BYTES,
  MAX_PROMPT_OVERRIDE_BYTES,
} from '../services/customization-store.js';
import { validateFragmentOverride } from './prompt-fragments.js';

export const BUNDLE_KIND = 'botmux-customization-bundle';
export const BUNDLE_SCHEMA_VERSION = 1 as const;

export interface CustomizationBundle {
  schemaVersion: 1;
  kind: typeof BUNDLE_KIND;
  /** Optional author-supplied name / note (metadata only). */
  name?: string;
  createdAt?: string;
  /** Prompt-key overrides per locale (inlined full strings). */
  promptOverrides?: Partial<Record<Locale, Record<string, string>>>;
  /** Conditional-line forced values. */
  conditionalLines?: Record<string, boolean>;
  /** Built-in skill overrides — each carries the FULL body inline (not a ref). */
  builtinSkills?: Record<string, { body?: string; disabled?: boolean }>;
}

export interface BundleDiffEntry {
  kind: 'prompt' | 'conditional' | 'skill';
  /** i18n key or skill name. */
  id: string;
  locale?: Locale;
  /** What the import would do to this item vs current state. */
  action: 'add' | 'replace' | 'unchanged' | 'disable';
  /** Short before/after preview for the confirm UI. */
  before?: string;
  after?: string;
}

export interface BundleImportPreview {
  bundle: CustomizationBundle;
  diff: BundleDiffEntry[];
  /** Aggregate counts for a quick summary line. */
  summary: { adds: number; replaces: number; disables: number; unchanged: number };
}

// ─── Export ──────────────────────────────────────────────────────────────────

/** Build a portable bundle from the current on-disk customization state.
 *  Skill bodies are inlined by reading their .md files. */
export function exportBundle(opts: { name?: string; createdAt?: string } = {}): CustomizationBundle {
  const state = readCustomizationState();
  const bundle: CustomizationBundle = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    kind: BUNDLE_KIND,
  };
  if (opts.name) bundle.name = opts.name;
  if (opts.createdAt) bundle.createdAt = opts.createdAt;

  if (state.promptOverrides && Object.keys(state.promptOverrides).length) {
    bundle.promptOverrides = state.promptOverrides;
  }
  if (state.conditionalLines && Object.keys(state.conditionalLines).length) {
    bundle.conditionalLines = state.conditionalLines;
  }
  if (state.builtinSkills && Object.keys(state.builtinSkills).length) {
    const skills: Record<string, { body?: string; disabled?: boolean }> = {};
    for (const [name, ov] of Object.entries(state.builtinSkills)) {
      const entry: { body?: string; disabled?: boolean } = {};
      if (ov.body !== undefined) {
        const body = readSkillOverrideBody(name);
        if (typeof body === 'string') entry.body = body; // inline the full text
      }
      if (ov.disabled) entry.disabled = true;
      if (entry.body !== undefined || entry.disabled) skills[name] = entry;
    }
    if (Object.keys(skills).length) bundle.builtinSkills = skills;
  }
  return bundle;
}

// ─── Parse / validate ────────────────────────────────────────────────────────

export class BundleError extends Error {}

/** Parse + validate raw JSON text into a CustomizationBundle. Throws
 *  BundleError with a human message on any structural problem. */
export function parseBundle(rawJson: string): CustomizationBundle {
  let parsed: unknown;
  try { parsed = JSON.parse(rawJson); }
  catch { throw new BundleError('不是合法的 JSON'); }
  if (!parsed || typeof parsed !== 'object') throw new BundleError('bundle 必须是一个 JSON 对象');
  const r = parsed as Record<string, unknown>;
  if (r.kind !== BUNDLE_KIND) throw new BundleError(`kind 必须是 "${BUNDLE_KIND}"`);
  if (r.schemaVersion !== BUNDLE_SCHEMA_VERSION) throw new BundleError(`不支持的 schemaVersion（期望 ${BUNDLE_SCHEMA_VERSION}）`);

  const out: CustomizationBundle = { schemaVersion: BUNDLE_SCHEMA_VERSION, kind: BUNDLE_KIND };
  if (typeof r.name === 'string') out.name = r.name.slice(0, 200);
  if (typeof r.createdAt === 'string') out.createdAt = r.createdAt;

  if (r.promptOverrides && typeof r.promptOverrides === 'object') {
    const po: Partial<Record<Locale, Record<string, string>>> = {};
    for (const [loc, map] of Object.entries(r.promptOverrides as Record<string, unknown>)) {
      if (!(SUPPORTED_LOCALES as readonly string[]).includes(loc)) continue;
      if (!map || typeof map !== 'object') continue;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
        if (typeof v !== 'string' || !k) continue;
        if (Buffer.byteLength(v, 'utf-8') > MAX_PROMPT_OVERRIDE_BYTES) {
          throw new BundleError(`prompt 覆盖过大：${k} (${loc})`);
        }
        // Enforce placeholder contracts on import too, so a bundle can't smuggle
        // in a broken {count}/{names} template.
        const err = validateFragmentOverride(k, v);
        if (err) throw new BundleError(`${k} (${loc})：${err}`);
        clean[k] = v;
      }
      if (Object.keys(clean).length) po[loc as Locale] = clean;
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
    const bs: Record<string, { body?: string; disabled?: boolean }> = {};
    for (const [name, ov] of Object.entries(r.builtinSkills as Record<string, unknown>)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new BundleError(`非法 skill 名：${name}`);
      if (!ov || typeof ov !== 'object') continue;
      const o = ov as Record<string, unknown>;
      const entry: { body?: string; disabled?: boolean } = {};
      if (typeof o.body === 'string') {
        if (Buffer.byteLength(o.body, 'utf-8') > MAX_SKILL_BODY_BYTES) {
          throw new BundleError(`skill 正文过大：${name}`);
        }
        entry.body = o.body;
      }
      if (o.disabled === true) entry.disabled = true;
      if (entry.body !== undefined || entry.disabled) bs[name] = entry;
    }
    if (Object.keys(bs).length) out.builtinSkills = bs;
  }

  return out;
}

// ─── Diff (confirm-before-apply preview) ─────────────────────────────────────

function preview(s: string | undefined, n = 60): string | undefined {
  if (s === undefined) return undefined;
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** Compute the diff a bundle import would produce against current state. Pure —
 *  reads current state but writes nothing. */
export function previewBundleImport(bundle: CustomizationBundle): BundleImportPreview {
  const current = readCustomizationState();
  const diff: BundleDiffEntry[] = [];

  // Prompt overrides
  for (const loc of Object.keys(bundle.promptOverrides ?? {}) as Locale[]) {
    const incoming = bundle.promptOverrides![loc] ?? {};
    for (const [key, val] of Object.entries(incoming)) {
      const existing = current.promptOverrides?.[loc]?.[key];
      const action = existing === undefined ? 'add' : existing === val ? 'unchanged' : 'replace';
      diff.push({ kind: 'prompt', id: key, locale: loc, action, before: preview(existing), after: preview(val) });
    }
  }

  // Conditional lines
  for (const [key, val] of Object.entries(bundle.conditionalLines ?? {})) {
    const existing = current.conditionalLines?.[key];
    const action = existing === undefined ? 'add' : existing === val ? 'unchanged' : 'replace';
    diff.push({ kind: 'conditional', id: key, action, before: existing === undefined ? undefined : String(existing), after: String(val) });
  }

  // Skills
  for (const [name, ov] of Object.entries(bundle.builtinSkills ?? {})) {
    const existing = current.builtinSkills?.[name];
    if (ov.disabled && !ov.body) {
      diff.push({ kind: 'skill', id: name, action: 'disable', after: '停用' });
      continue;
    }
    const existingBody = existing?.body !== undefined ? readSkillOverrideBody(name) : undefined;
    const action = existingBody === undefined ? 'add' : existingBody === ov.body ? 'unchanged' : 'replace';
    diff.push({ kind: 'skill', id: name, action, before: preview(existingBody), after: preview(ov.body) });
  }

  const summary = {
    adds: diff.filter((d) => d.action === 'add').length,
    replaces: diff.filter((d) => d.action === 'replace').length,
    disables: diff.filter((d) => d.action === 'disable').length,
    unchanged: diff.filter((d) => d.action === 'unchanged').length,
  };
  return { bundle, diff, summary };
}

// ─── Apply ───────────────────────────────────────────────────────────────────

/**
 * Apply a validated bundle by REPLACING the current customization content with
 * it (snapshotting first, so it's reversible). Returns the resulting state.
 *
 * "Replace" (not merge) is deliberate for P0: it makes import deterministic and
 * the diff preview honest — what you see is exactly the resulting state. A merge
 * mode can be layered on later if requested.
 */
export function applyBundle(bundle: CustomizationBundle, label = 'import bundle'): CustomizationState {
  const next: CustomizationState = { schemaVersion: 1 };
  if (bundle.promptOverrides) next.promptOverrides = bundle.promptOverrides;
  if (bundle.conditionalLines) next.conditionalLines = bundle.conditionalLines;
  const skillBodies: Record<string, string> = {};
  if (bundle.builtinSkills) {
    const bs: NonNullable<CustomizationState['builtinSkills']> = {};
    for (const [name, ov] of Object.entries(bundle.builtinSkills)) {
      const entry: { body?: string; disabled?: boolean } = {};
      if (typeof ov.body === 'string') { entry.body = ov.body; skillBodies[name] = ov.body; }
      if (ov.disabled) entry.disabled = true;
      if (entry.body !== undefined || entry.disabled) bs[name] = entry;
    }
    if (Object.keys(bs).length) next.builtinSkills = bs;
  }
  return replaceState(next, skillBodies, label);
}

/** Serialize a bundle to pretty JSON (with a trailing newline) for file output. */
export function serializeBundle(bundle: CustomizationBundle): string {
  return JSON.stringify(bundle, null, 2) + '\n';
}
