/**
 * Dashboard HTTP API for the customization center (built-in prompt/skill
 * overrides + sharing). Split out of dashboard.ts to keep that file lean.
 *
 * GET  /api/customization            — full snapshot for the page (fragments,
 *                                        skills, master flag, history)
 * PUT  /api/customization/enabled    — { enabled: boolean } master switch
 * PUT  /api/customization/prompt     — { locale, key, value|null }
 * PUT  /api/customization/condition  — { key, value: boolean|null }
 * PUT  /api/customization/skill      — { name, body?: string|null, disabled?: boolean }
 * POST /api/customization/reset-all  — wipe all overrides (snapshotted)
 * POST /api/customization/rollback   — { id }
 * GET  /api/customization/export     — download a portable bundle
 * POST /api/customization/import     — { json, apply?: boolean } → diff preview or apply
 *
 * Scope: every route takes an optional `?scope=` query parameter
 * (services/customization-scope.ts). Absent — or `feishu` — is the original
 * Feishu store, with requests, responses, error codes and on-disk results
 * exactly as before scopes existed. `wecom` addresses the WeCom store: its
 * catalog is im/wecom/contract/prompt-fragments.ts (only copy a WeCom session
 * really renders; unknown keys are refused), it has no built-in skills, and
 * gateway lines accept only their fixed locale. Any other value (or a repeated
 * parameter) is refused with 400 `unknown_scope` — never silently Feishu.
 *
 * The WeCom scope is a WeCom surface: like every `/api/wecom/*` route it is the
 * host admin's only (403 `wecom_host_admin_required` for anyone else, reads
 * included — a co-manager is not told WeCom exists), and its writes pass the
 * control CSRF check. dashboard.ts supplies both through `access`; without it
 * the WeCom scope is refused. The Feishu scope ignores `access` entirely.
 *
 * Auth: dashboard.ts routes all non-PUBLIC_READ_PATHS writes through
 * decideDashboardAuth first, so every mutation here is already owner-gated. Only
 * the GET snapshot + GET export are reads.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from './http.js';
import type { Locale } from '../i18n/types.js';
import { SUPPORTED_LOCALES } from '../i18n/types.js';
import { shippedText } from '../i18n/index.js';
import {
  readCustomizationState,
  customizationEnabled,
  setCustomizationEnabled,
  setPromptOverride,
  setConditionalLine,
  setSkillOverrideBody,
  setSkillDisabled,
  readSkillOverrideBody,
  resetAllToFactory,
  rollbackToSnapshot,
  listSnapshots,
  isCustomizationScope,
  DEFAULT_CUSTOMIZATION_SCOPE,
  CUSTOMIZATION_SCOPE_HAS_NO_SKILLS,
  type CustomizationScope,
} from '../services/customization-store.js';
import {
  PROMPT_FRAGMENTS,
  PROMPT_STAGES,
  BLOCK_META,
  validateFragmentOverride,
  validateOverrideForSpec,
  type PromptFragmentSpec,
} from '../skills/prompt-fragments.js';
import {
  wecomCustomizationFragments,
  wecomCustomizationBlocks,
  wecomCustomizationStages,
  wecomFragmentFactory,
} from '../im/wecom/contract/prompt-fragments.js';
import { customizationBundleScopeRejection, feishuStoreKeyRejection } from '../im/wecom/contract/customization.js';
import { BUILTIN_SKILLS } from '../skills/definitions.js';
import { frontmatterDescription } from '../skills/injection-mode.js';
import {
  exportBundle,
  parseBundle,
  previewBundleImport,
  applyBundle,
  serializeBundle,
  BundleError,
  type CustomizationBundle,
} from '../skills/customization-bundle.js';

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

/** The scope a request names: absent = Feishu (legacy); invalid when unknown or repeated. */
function requestScope(url: URL): CustomizationScope | undefined {
  const values = url.searchParams.getAll('scope');
  if (values.length === 0) return DEFAULT_CUSTOMIZATION_SCOPE;
  return values.length === 1 && isCustomizationScope(values[0]) ? values[0] : undefined;
}

/** The WeCom catalog lookup (the Feishu scope keeps its historical, permissive rules). */
function wecomSpec(key: string): PromptFragmentSpec | undefined {
  return wecomCustomizationFragments().find((f) => f.key === key);
}

/** Why `value` may not be stored for (locale, key) in the WeCom store, if it may not. */
function wecomPromptRejection(locale: Locale, key: string, value: string | null): string | undefined {
  const spec = wecomSpec(key);
  if (!spec) return 'unknown_fragment';
  if (spec.fixedLocale && spec.fixedLocale !== locale) return 'fragment_locale_fixed';
  return value === null ? undefined : validateOverrideForSpec(spec, value);
}

/** A bundle the WeCom store can hold: catalog keys only, no skills. Human message, like parseBundle. */
function wecomBundleRejection(bundle: CustomizationBundle): string | undefined {
  if (bundle.builtinSkills && Object.keys(bundle.builtinSkills).length) return '企业微信这套自定义没有内置 skill，bundle 里不能带 builtinSkills';
  for (const key of Object.keys(bundle.conditionalLines ?? {})) {
    if (wecomSpec(key)?.kind !== 'conditional') return `企业微信会话不使用条件行：${key}`;
  }
  for (const [loc, map] of Object.entries(bundle.promptOverrides ?? {})) {
    for (const [key, value] of Object.entries(map ?? {})) {
      const reason = wecomPromptRejection(loc as Locale, key, value);
      if (reason === 'unknown_fragment') return `企业微信会话不使用这条片段：${key}`;
      if (reason === 'fragment_locale_fixed') return `${key} 只按 ${wecomSpec(key)?.fixedLocale} 渲染，不能导入 ${loc} 的覆盖`;
      if (reason) return `${key} (${loc})：${reason}`;
    }
  }
  return undefined;
}

/** Build the full page payload: every fragment with factory + override text
 *  (per locale), every built-in skill with override/disable state, plus the
 *  master flag and history. This is the single GET the React page hydrates from.
 *  The Feishu scope's payload is byte-identical to the pre-scope one. */
function buildSnapshot(scope: CustomizationScope = DEFAULT_CUSTOMIZATION_SCOPE) {
  const wecom = scope === 'wecom';
  const state = readCustomizationState(scope);
  const catalog = wecom ? wecomCustomizationFragments() : PROMPT_FRAGMENTS;
  const factory = wecom ? wecomFragmentFactory : shippedText;
  const fragments = catalog.map((f) => {
    const perLocale: Record<string, { factory: string; override: string | null }> = {};
    for (const loc of SUPPORTED_LOCALES) {
      perLocale[loc] = {
        factory: factory(f.key, loc),
        override: state.promptOverrides?.[loc]?.[f.key] ?? null,
      };
    }
    const out: any = {
      key: f.key,
      block: f.block,
      stage: f.stage,
      label: f.label,
      kind: f.kind,
      locales: perLocale,
    };
    if (f.stages && f.stages.length > 0) out.stages = f.stages;
    if (f.placeholders) out.placeholders = f.placeholders;
    if (f.gate) out.gate = f.gate;
    if (f.gateLabel) out.gateLabel = f.gateLabel;
    if (f.kind === 'conditional') out.conditionForced = state.conditionalLines?.[f.key] ?? null;
    if (f.fixedLocale) out.fixedLocale = f.fixedLocale;
    return out;
  });

  const skills = wecom ? [] : BUILTIN_SKILLS.map((s) => {
    const ov = state.builtinSkills?.[s.name];
    return {
      name: s.name,
      description: frontmatterDescription(s.content),
      factory: s.content,
      override: ov?.body !== undefined ? (readSkillOverrideBody(s.name) ?? null) : null,
      disabled: ov?.disabled === true,
    };
  });

  return {
    enabled: customizationEnabled(scope),
    stages: wecom ? wecomCustomizationStages() : PROMPT_STAGES,
    blocks: Object.entries(wecom ? wecomCustomizationBlocks() : BLOCK_META).map(([id, meta]) => ({ id, ...meta })),
    fragments,
    skills,
    history: listSnapshots(scope),
  };
}

/** What dashboard.ts knows about the caller, for the WeCom scope only. */
export interface CustomizationApiAccess {
  /** Same test as the `/api/wecom/*` routes: legacyAuthed && identity.kind === 'legacy-dashboard'. */
  wecomHostAdmin: boolean;
  /** The control CSRF check; on failure it has already written the 403 response. */
  wecomCsrfValid: () => boolean;
}

/** Returns true if it handled the request. */
export async function handleCustomizationApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  access?: CustomizationApiAccess,
): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/customization')) return false;
  const scope = requestScope(url);
  if (!scope) {
    jsonRes(res, 400, { ok: false, error: 'unknown_scope' });
    return true;
  }
  const wecom = scope === 'wecom';
  if (wecom) {
    if (access?.wecomHostAdmin !== true) {
      jsonRes(res, 403, { ok: false, error: 'wecom_host_admin_required' });
      return true;
    }
    if (req.method !== 'GET' && !access.wecomCsrfValid()) return true;
  }
  const snapshot = () => buildSnapshot(scope);

  try {
    if (req.method === 'GET' && p === '/api/customization') {
      jsonRes(res, 200, snapshot());
      return true;
    }

    if (req.method === 'GET' && p === '/api/customization/export') {
      const bundle = exportBundle({ name: url.searchParams.get('name') ?? undefined }, scope);
      const json = serializeBundle(bundle);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': wecom
          ? 'attachment; filename="botmux-customization-wecom.json"'
          : 'attachment; filename="botmux-customization.json"',
      });
      res.end(json);
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/enabled') {
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') { jsonRes(res, 400, { ok: false, error: 'enabled_must_be_boolean' }); return true; }
      setCustomizationEnabled(body.enabled, scope);
      jsonRes(res, 200, { ok: true, snapshot: snapshot() });
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/prompt') {
      const body = await readJsonBody(req);
      if (!isLocale(body.locale) || typeof body.key !== 'string') { jsonRes(res, 400, { ok: false, error: 'bad_locale_or_key' }); return true; }
      const value: string | null = body.value === null || body.value === undefined ? null : String(body.value);
      if (wecom) {
        const rejection = wecomPromptRejection(body.locale, body.key, value);
        if (rejection) { jsonRes(res, 400, { ok: false, error: rejection }); return true; }
      } else if (value !== null) {
        // WeCom-only keys never enter the Feishu store (removing one stays possible).
        const vErr = feishuStoreKeyRejection(body.key) ?? validateFragmentOverride(body.key, value);
        if (vErr) { jsonRes(res, 400, { ok: false, error: vErr }); return true; }
      }
      setPromptOverride(body.locale, body.key, value, scope);
      jsonRes(res, 200, { ok: true, snapshot: snapshot() });
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/condition') {
      const body = await readJsonBody(req);
      if (typeof body.key !== 'string') { jsonRes(res, 400, { ok: false, error: 'bad_key' }); return true; }
      if (wecom && wecomSpec(body.key)?.kind !== 'conditional') { jsonRes(res, 400, { ok: false, error: 'unknown_fragment' }); return true; }
      const value: boolean | null = body.value === null || body.value === undefined ? null : Boolean(body.value);
      const keyRejection = !wecom && value !== null ? feishuStoreKeyRejection(body.key) : undefined;
      if (keyRejection) { jsonRes(res, 400, { ok: false, error: keyRejection }); return true; }
      setConditionalLine(body.key, value, scope);
      jsonRes(res, 200, { ok: true, snapshot: snapshot() });
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/skill') {
      const body = await readJsonBody(req);
      if (wecom) { jsonRes(res, 400, { ok: false, error: CUSTOMIZATION_SCOPE_HAS_NO_SKILLS }); return true; }
      if (typeof body.name !== 'string' || !BUILTIN_SKILLS.some((s) => s.name === body.name)) {
        jsonRes(res, 400, { ok: false, error: 'unknown_skill' }); return true;
      }
      // body: set/clear override text; disabled: toggle injection. Either or both.
      try {
        if ('body' in body) {
          const b: string | null = body.body === null || body.body === undefined ? null : String(body.body);
          setSkillOverrideBody(body.name, b);
        }
        if ('disabled' in body) setSkillDisabled(body.name, Boolean(body.disabled));
      } catch (e: any) {
        jsonRes(res, 400, { ok: false, error: e?.message ?? 'skill_write_failed' }); return true;
      }
      jsonRes(res, 200, { ok: true, snapshot: snapshot() });
      return true;
    }

    if (req.method === 'POST' && p === '/api/customization/reset-all') {
      resetAllToFactory(scope);
      jsonRes(res, 200, { ok: true, snapshot: snapshot() });
      return true;
    }

    if (req.method === 'POST' && p === '/api/customization/rollback') {
      const body = await readJsonBody(req);
      if (typeof body.id !== 'string') { jsonRes(res, 400, { ok: false, error: 'bad_id' }); return true; }
      try {
        rollbackToSnapshot(body.id, scope);
      } catch (e: any) {
        jsonRes(res, 400, { ok: false, error: e?.message ?? 'rollback_failed' }); return true;
      }
      jsonRes(res, 200, { ok: true, snapshot: snapshot() });
      return true;
    }

    if (req.method === 'POST' && p === '/api/customization/import') {
      const body = await readJsonBody(req);
      if (typeof body.json !== 'string') { jsonRes(res, 400, { ok: false, error: 'missing_json' }); return true; }
      let bundle;
      try { bundle = parseBundle(body.json); }
      catch (e) { jsonRes(res, 400, { ok: false, error: e instanceof BundleError ? e.message : 'bad_bundle' }); return true; }
      // A bundle belongs to the store it was exported from (WeCom exports carry
      // `scope: "wecom"`); for Feishu this refuses only inputs that could not
      // exist before the WeCom store did.
      const rejection = customizationBundleScopeRejection(bundle, scope) ?? (wecom ? wecomBundleRejection(bundle) : undefined);
      if (rejection) { jsonRes(res, 400, { ok: false, error: rejection }); return true; }
      const preview = previewBundleImport(bundle, scope);
      if (body.apply === true) {
        applyBundle(bundle, `import bundle${bundle.name ? `: ${bundle.name}` : ''}`, scope);
        jsonRes(res, 200, { ok: true, applied: true, preview, snapshot: snapshot() });
        return true;
      }
      jsonRes(res, 200, { ok: true, applied: false, preview });
      return true;
    }

    // Under /api/customization but no method/path match.
    jsonRes(res, 404, { ok: false, error: 'not_found' });
    return true;
  } catch (err: any) {
    jsonRes(res, 500, { ok: false, error: err?.message ?? 'customization_api_error' });
    return true;
  }
}
