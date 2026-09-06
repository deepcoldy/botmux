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

/** Whether `scope` is a real Lark user scope. An empty catalog accepts
 *  everything, so a packaging problem cannot lock people out of /login. */
export function isKnownLarkUserScope(scope: string): boolean {
  return USER_SCOPES.size === 0 || USER_SCOPES.has(scope);
}
