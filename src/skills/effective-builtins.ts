/**
 * Effective built-in resolution — the layer that merges shipped built-in
 * prompt copy + skills with the user's overrides from {@link customization-store}.
 *
 * This is the ONLY place the two systems meet. It exposes:
 *   - {@link registerPromptOverrideResolver}: wires the store into i18n `t()` so
 *     every keyed built-in prompt string can be overridden per-locale.
 *   - {@link effectiveBuiltinSkills} / {@link effectiveBuiltinSkillContent}: the
 *     shipped BUILTIN_SKILLS with per-skill body overrides applied and disabled
 *     skills removed — consumed by injection-mode (catalog) and installer (files).
 *   - {@link resolveConditionalLine}: lets a user force a gated prompt line on/off.
 *
 * BYTE-IDENTICAL GUARANTEE: when customization is disabled, or there are no
 * overrides, every function here returns the shipped default unchanged. Callers
 * that had no override get exactly the pre-feature bytes.
 */
import type { Locale } from '../i18n/types.js';
import { setPromptOverrideResolver } from '../i18n/index.js';
import {
  customizationEnabled,
  readCustomizationState,
  readSkillOverrideBody,
} from '../services/customization-store.js';
import type { SkillDef } from './definitions.js';

// ─── Prompt key overrides → i18n t() ─────────────────────────────────────────

/**
 * Register the store as i18n's prompt-override resolver. Safe to call more than
 * once — it simply (re)installs the same resolver closure, which reads store
 * state live on each lookup. Kept as an explicit registration rather than an
 * import side-effect so the pure i18n module never transitively pulls in the
 * filesystem-backed store.
 */
export function registerPromptOverrideResolver(): void {
  setPromptOverrideResolver((key: string, locale: Locale): string | undefined => {
    // Master off ⇒ no overrides ⇒ shipped bytes.
    if (!customizationEnabled()) return undefined;
    const state = readCustomizationState();
    return state.promptOverrides?.[locale]?.[key];
  });
}

// ─── Conditional prompt lines ────────────────────────────────────────────────

/**
 * Resolve whether a gated prompt line should render. `shippedDefault` is the
 * value the shipped code computed (e.g. `config.noVisibleOutputHint`). A user
 * override forces it either way; absent override returns the shipped default,
 * so gating behaves exactly as before when uncustomized.
 */
export function resolveConditionalLine(key: string, shippedDefault: boolean): boolean {
  if (!customizationEnabled()) return shippedDefault;
  const forced = readCustomizationState().conditionalLines?.[key];
  return typeof forced === 'boolean' ? forced : shippedDefault;
}

// ─── Built-in skill overrides ────────────────────────────────────────────────

/**
 * Apply user overrides to the shipped built-in skill list:
 *   - a skill marked `disabled` is removed entirely (not injected anywhere)
 *   - a skill with an override body has its `content` replaced
 *   - everything else passes through untouched
 *
 * Returns a NEW array; the shipped `defs` is never mutated. When customization
 * is off or no skill overrides exist, returns a shallow copy equal to `defs`.
 */
export function effectiveBuiltinSkills(defs: SkillDef[]): SkillDef[] {
  if (!customizationEnabled()) return defs.slice();
  const overrides = readCustomizationState().builtinSkills;
  if (!overrides || !Object.keys(overrides).length) return defs.slice();
  const out: SkillDef[] = [];
  for (const def of defs) {
    const ov = overrides[def.name];
    if (!ov) { out.push(def); continue; }
    if (ov.disabled) continue; // drop disabled skills
    if (ov.body !== undefined) {
      const body = readSkillOverrideBody(def.name);
      out.push({ name: def.name, content: typeof body === 'string' ? body : def.content });
    } else {
      out.push(def);
    }
  }
  return out;
}

/**
 * Resolve the effective content for a single built-in skill by name, given its
 * shipped default. Returns:
 *   - `undefined` if the skill is disabled (caller should treat as absent)
 *   - the override body if one is set
 *   - `shippedContent` otherwise
 */
export function effectiveBuiltinSkillContent(name: string, shippedContent: string): string | undefined {
  if (!customizationEnabled()) return shippedContent;
  const ov = readCustomizationState().builtinSkills?.[name];
  if (!ov) return shippedContent;
  if (ov.disabled) return undefined;
  if (ov.body !== undefined) {
    const body = readSkillOverrideBody(name);
    return typeof body === 'string' ? body : shippedContent;
  }
  return shippedContent;
}

/**
 * True only when an enabled customization supplies a replacement body for the
 * named built-in. File delivery uses this to keep an explicit user body ahead
 * of botmux's stable session-loader indirection.
 */
export function isBuiltinSkillBodyOverridden(name: string): boolean {
  if (!customizationEnabled()) return false;
  return readCustomizationState().builtinSkills?.[name]?.body !== undefined;
}

/** True if the named built-in skill is disabled by the user (and customization
 *  is on). Lets callers that iterate names skip disabled skills cheaply. */
export function isBuiltinSkillDisabled(name: string): boolean {
  if (!customizationEnabled()) return false;
  return readCustomizationState().builtinSkills?.[name]?.disabled === true;
}
