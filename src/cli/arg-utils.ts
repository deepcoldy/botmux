/**
 * Small argv helpers used by botmux subcommands. Lives in a side-effect-free
 * module so tests can import them without triggering cli.ts's top-level
 * dispatcher switch.
 */

/** Pick the first positional (non-flag, non-flag-value) token from `args`.
 *  Skips both `--name` flags AND their following value tokens, so
 *  `cmd --session-id <uuid> om_xxx` correctly returns `om_xxx`. Flags that
 *  take values must be passed in `flagsWithValue` to avoid eating their args. */
export function firstPositional(args: string[], flagsWithValue: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flagsWithValue.includes(a)) { i++; continue; }            // --flag value
    if (flagsWithValue.some(f => a.startsWith(f + '='))) continue; // --flag=value
    if (a.startsWith('-')) continue;                              // unknown flag / boolean
    return a;
  }
  return undefined;
}

/** True if `flag` is present in either bare (`--team`) or `=`-value (`--team=t1`)
 *  form. Use for presence checks on flags that ALSO carry a value via
 *  argValue/argValues, where a bare `args.includes(flag)` misses the
 *  `--flag=value` spelling (e.g. team-mode routing on `create-group`). */
export function hasFlagOrEq(args: string[], flag: string): boolean {
  return args.some(a => a === flag || a.startsWith(flag + '='));
}

/** True when a value-taking flag is present without a usable value.
 *
 * Rejects the bare flag at argv end, an empty `--flag=` form, and a following
 * flag token. A lone `-` remains a valid value for stdin-taking flags.
 *
 * ⚠️ `allowDash` defaults to **true** here, which is the OPPOSITE of the
 * same-named private copy in `cli.ts` (it defaults to `false`) and of the one
 * in `card-dispatch.ts` (which has no such parameter and always rejects `-`).
 * The default is load-bearing, not cosmetic: callers that omit the argument —
 * `--content`, `--summary`, `--message-id`, `--stream-id`, `--element-id` in
 * `card-stream-dispatch.ts` — accept a lone `-`, while `--session-id` opts out
 * with an explicit `false` because a session id is a UUID, never a dash.
 *
 * So when folding the remaining private copies into this one, do NOT assume
 * the call sites are drop-in: `cli.ts` has six that rely on its `false`
 * default (`--plugin-card-action` ×2, `--response-kind`, `--into`,
 * `--dispatch-root`, `--from-chat`), and pointing them here would silently
 * start accepting `-` as their value. Re-check each site and pass the flag
 * explicitly rather than inheriting whichever default happens to be in scope.
 */
export function flagPresentButValueMissing(
  args: readonly string[],
  flag: string,
  allowDash = true,
): boolean {
  const i = args.findIndex(a => a === flag || a.startsWith(`${flag}=`));
  if (i < 0) return false;
  if (args[i].startsWith(`${flag}=`)) {
    const value = args[i].slice(flag.length + 1);
    return value === '' || (!allowDash && value === '-');
  }
  const next = args[i + 1];
  return next === undefined || (next.startsWith('-') && !(allowDash && next === '-'));
}

/** The flag-looking tokens in `args` that this subcommand does not know.
 *
 *  Motivation: every parser in this file (and `argValue` / `argFlag` in cli.ts)
 *  *pulls* the flags it wants out of argv and ignores the rest. That is fine
 *  until the user's mental model of the flag set differs from the real one:
 *  the misspelled or invented flag is then dropped in silence and the command
 *  runs with its defaults, which is indistinguishable from the command having
 *  understood the request. `botmux history --thread` reads as "read the thread"
 *  and quietly returns the *session* scope instead.
 *
 *  Value tokens are skipped, so `--scope chat` does not report `chat`, and
 *  `--scope=chat` is recognized in its `=` spelling too. Positional tokens are
 *  deliberately NOT reported — only things that look like flags.
 */
export function unknownFlags(
  args: readonly string[],
  known: { valueFlags?: readonly string[]; boolFlags?: readonly string[] },
): string[] {
  const valueFlags = known.valueFlags ?? [];
  const boolFlags = known.boolFlags ?? [];
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) { i++; continue; }                 // --flag value
    if (valueFlags.some(f => a.startsWith(f + '='))) continue;     // --flag=value
    if (boolFlags.includes(a)) continue;
    if (a.startsWith('-')) out.push(a);
  }
  return out;
}
