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
