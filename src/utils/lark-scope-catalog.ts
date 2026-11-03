/**
 * The set of Lark USER scopes that actually exist.
 *
 * Worth validating against rather than trusting the caller: a misspelled scope
 * does not degrade gracefully. Feishu rejects the whole authorize URL with
 * 20043, so the person is handed a link that simply fails to open — with no
 * indication that one word in it was wrong. That has already happened here once
 * (commit 487e297d: a bare `docs:document.comment`, which is not a real scope).
 *
 * Names come from the same generated catalog `botmux setup` uses, so this stays
 * in step with the console rather than drifting as a hand-kept list.
 */
// Import attribute rather than a runtime read: this is how cli.ts already
// bundles the same file, so the catalog travels with the build (including the
// compiled binary) instead of depending on a path that exists only in a source
// checkout.
import scopeManifest from '../setup/lark-scopes.json' with { type: 'json' };

const USER_SCOPES: ReadonlySet<string> = new Set(
  (scopeManifest as { scopes?: { user?: string[] } }).scopes?.user ?? [],
);

export function isValidLarkScopeSyntax(scope: string): boolean {
  return /^[a-z0-9_]+(:[a-z0-9_.-]+)+$/i.test(scope) || scope === 'offline_access';
}

/** Whether `scope` is a real Lark user scope. An empty catalog accepts
 *  everything, so a packaging problem cannot lock people out of /login.
 *  When `options.allowUnknown` is true (or BOTMUX_ALLOW_UNKNOWN_SCOPES=1),
 *  syntactically valid Lark scopes are accepted as an escape hatch. */
export function isKnownLarkUserScope(
  scope: string,
  options?: { allowUnknown?: boolean },
): boolean {
  if (USER_SCOPES.size === 0) return true;
  if (USER_SCOPES.has(scope) || scope === 'im:chat' || scope === 'im:chat:readonly') return true;
  if (options?.allowUnknown || process.env.BOTMUX_ALLOW_UNKNOWN_SCOPES === '1') {
    return isValidLarkScopeSyntax(scope);
  }
  return false;
}
