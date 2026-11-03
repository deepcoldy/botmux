/** Transfer cleanup ownership after preparing a replacement sandbox.
 * Existing-tree reuse points both closures at the same tree, so invoking the old
 * owner would delete the successfully prepared replacement. Ordinary replacement
 * still retires the old tree before installing the new owner. */
export function transferSandboxCleanupOwnership(
  previous: (() => void) | null,
  replacement: () => void,
  reusingExistingTree: boolean,
): () => void {
  if (!reusingExistingTree && previous) previous();
  return replacement;
}
