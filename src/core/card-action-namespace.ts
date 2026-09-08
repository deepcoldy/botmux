/**
 * Card-action selectors owned by Botmux itself.
 *
 * Plugins are install-time trusted code, but their cards share the same Lark
 * callback channel as Botmux's own operational controls.  Keeping the core
 * namespace explicit prevents a plugin declaration from shadowing an existing
 * close/restart/repository/dashboard action before the built-in handler sees it.
 *
 * New built-in action families must be added here.  Prefixes intentionally
 * reserve the whole family so a later action in that family is protected too.
 */
const BOTMUX_CARD_ACTION_EXACT = new Set([
  'add',
  'close',
  'disconnect',
  'grant',
  'help',
  'park',
  'restart',
  'resume',
  'stop',
  'takeover',
]);

const BOTMUX_CARD_ACTION_PREFIXES = [
  'adopt_',
  'ask_',
  'clean_',
  'close_',
  'codex_',
  'compact_',
  'config_',
  'dash_',
  'export_',
  'feedback_',
  'get_',
  'grant_',
  'issue_',
  'open_',
  'overload_',
  'refresh_',
  'relay_',
  'repo_',
  'retry_',
  'set_',
  'skill_',
  'skip_',
  'stop_',
  'suspend_',
  'term_',
  'toggle_',
  'tui_',
  'v3_',
  'vc_',
  'voice_',
  'wf_',
  'worktree_',
] as const;

export function isBotmuxCardAction(action: string): boolean {
  return BOTMUX_CARD_ACTION_EXACT.has(action)
    || BOTMUX_CARD_ACTION_PREFIXES.some(prefix => action.startsWith(prefix));
}

/** Reject a plugin prefix whenever its matching set intersects a core selector. */
export function pluginCardActionSelectorOverlapsBotmux(
  selector: string,
  kind: 'action' | 'prefix',
): boolean {
  if (kind === 'action') return isBotmuxCardAction(selector);
  for (const action of BOTMUX_CARD_ACTION_EXACT) {
    // An exact action overlaps a plugin prefix only when that exact value
    // starts with the prefix. `close.plugin.` does not match exact `close`.
    if (action.startsWith(selector)) return true;
  }
  return BOTMUX_CARD_ACTION_PREFIXES.some(prefix => (
    prefix.startsWith(selector) || selector.startsWith(prefix)
  ));
}
