/** Parse the tab-separated model IDs and display names returned by `agy models`. */
export function parseAntigravityModels(stdout: string): string[] {
  const models = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    // Progress messages and errors are not model rows; never offer them as IDs.
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._:/-]*)\t[^\t\r\n]+$/.exec(line.trim());
    if (match) models.add(match[1]!);
  }
  return [...models];
}
