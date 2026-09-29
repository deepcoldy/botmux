const FROZEN_COMMAND_LIFECYCLE_FLAGS = new Set(['--reason', '--replacement', '--file']);

/** Read a multi-token lifecycle flag until the next flag owned by this command.
 * Tokens such as `--legacy` are valid reason text and must not be truncated. */
export function frozenCommandLifecycleFlagValue(
  args: readonly string[],
  flag: '--reason' | '--replacement' | '--file',
): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const values: string[] = [];
  for (
    let cursor = index + 1;
    cursor < args.length && !FROZEN_COMMAND_LIFECYCLE_FLAGS.has(args[cursor]!);
    cursor += 1
  ) {
    values.push(args[cursor]!);
  }
  return values.join(' ').trim() || undefined;
}
