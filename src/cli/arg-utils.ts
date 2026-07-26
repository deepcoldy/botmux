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

/** Collect values from repeatable `--flag value` / `--flag=value` options. */
export function argValues(args: string[], ...flags: string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const equalsFlag = flags.find(flag => arg.startsWith(`${flag}=`));
    if (equalsFlag) {
      const value = arg.slice(equalsFlag.length + 1).trim();
      if (value) values.push(value);
      continue;
    }
    if (!flags.includes(arg)) continue;
    const value = args[i + 1];
    if (value !== undefined && !value.startsWith('--')) {
      const trimmed = value.trim();
      if (trimmed) values.push(trimmed);
      i++;
    }
  }
  return values;
}

/** Pick the first value from a set of equivalent option names. */
export function argValue(args: string[], ...flags: string[]): string | undefined {
  return argValues(args, ...flags)[0];
}
