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
} from '../services/customization-store.js';
import { PROMPT_FRAGMENTS, validateFragmentOverride } from '../skills/prompt-fragments.js';
import { BUILTIN_SKILLS } from '../skills/definitions.js';
import { frontmatterDescription } from '../skills/injection-mode.js';
import {
  exportBundle,
  parseBundle,
  previewBundleImport,
  applyBundle,
  serializeBundle,
  BundleError,
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

/** Build the full page payload: every fragment with factory + override text
 *  (per locale), every built-in skill with override/disable state, plus the
 *  master flag and history. This is the single GET the React page hydrates from. */
function buildSnapshot() {
  const state = readCustomizationState();
  const fragments = PROMPT_FRAGMENTS.map((f) => {
    const perLocale: Record<string, { factory: string; override: string | null }> = {};
    for (const loc of SUPPORTED_LOCALES) {
      perLocale[loc] = {
        factory: shippedText(f.key, loc),
        override: state.promptOverrides?.[loc]?.[f.key] ?? null,
      };
    }
    const out: any = {
      key: f.key,
      block: f.block,
      label: f.label,
      kind: f.kind,
      locales: perLocale,
    };
    if (f.placeholders) out.placeholders = f.placeholders;
    if (f.gate) out.gate = f.gate;
    if (f.kind === 'conditional') out.conditionForced = state.conditionalLines?.[f.key] ?? null;
    return out;
  });

  const skills = BUILTIN_SKILLS.map((s) => {
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
    enabled: customizationEnabled(),
    fragments,
    skills,
    history: listSnapshots(),
  };
}

/** Returns true if it handled the request. */
export async function handleCustomizationApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith('/api/customization')) return false;

  try {
    if (req.method === 'GET' && p === '/api/customization') {
      jsonRes(res, 200, buildSnapshot());
      return true;
    }

    if (req.method === 'GET' && p === '/api/customization/export') {
      const bundle = exportBundle({ name: url.searchParams.get('name') ?? undefined });
      const json = serializeBundle(bundle);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="botmux-customization.json"',
      });
      res.end(json);
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/enabled') {
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') { jsonRes(res, 400, { ok: false, error: 'enabled_must_be_boolean' }); return true; }
      setCustomizationEnabled(body.enabled);
      jsonRes(res, 200, { ok: true, snapshot: buildSnapshot() });
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/prompt') {
      const body = await readJsonBody(req);
      if (!isLocale(body.locale) || typeof body.key !== 'string') { jsonRes(res, 400, { ok: false, error: 'bad_locale_or_key' }); return true; }
      const value: string | null = body.value === null || body.value === undefined ? null : String(body.value);
      if (value !== null) {
        const vErr = validateFragmentOverride(body.key, value);
        if (vErr) { jsonRes(res, 400, { ok: false, error: vErr }); return true; }
      }
      setPromptOverride(body.locale, body.key, value);
      jsonRes(res, 200, { ok: true, snapshot: buildSnapshot() });
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/condition') {
      const body = await readJsonBody(req);
      if (typeof body.key !== 'string') { jsonRes(res, 400, { ok: false, error: 'bad_key' }); return true; }
      const value: boolean | null = body.value === null || body.value === undefined ? null : Boolean(body.value);
      setConditionalLine(body.key, value);
      jsonRes(res, 200, { ok: true, snapshot: buildSnapshot() });
      return true;
    }

    if (req.method === 'PUT' && p === '/api/customization/skill') {
      const body = await readJsonBody(req);
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
      jsonRes(res, 200, { ok: true, snapshot: buildSnapshot() });
      return true;
    }

    if (req.method === 'POST' && p === '/api/customization/reset-all') {
      resetAllToFactory();
      jsonRes(res, 200, { ok: true, snapshot: buildSnapshot() });
      return true;
    }

    if (req.method === 'POST' && p === '/api/customization/rollback') {
      const body = await readJsonBody(req);
      if (typeof body.id !== 'string') { jsonRes(res, 400, { ok: false, error: 'bad_id' }); return true; }
      try {
        rollbackToSnapshot(body.id);
      } catch (e: any) {
        jsonRes(res, 400, { ok: false, error: e?.message ?? 'rollback_failed' }); return true;
      }
      jsonRes(res, 200, { ok: true, snapshot: buildSnapshot() });
      return true;
    }

    if (req.method === 'POST' && p === '/api/customization/import') {
      const body = await readJsonBody(req);
      if (typeof body.json !== 'string') { jsonRes(res, 400, { ok: false, error: 'missing_json' }); return true; }
      let bundle;
      try { bundle = parseBundle(body.json); }
      catch (e) { jsonRes(res, 400, { ok: false, error: e instanceof BundleError ? e.message : 'bad_bundle' }); return true; }
      const preview = previewBundleImport(bundle);
      if (body.apply === true) {
        applyBundle(bundle, `import bundle${bundle.name ? `: ${bundle.name}` : ''}`);
        jsonRes(res, 200, { ok: true, applied: true, preview, snapshot: buildSnapshot() });
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
