/**
 * `npm pack --json` changed its top-level shape across majors:
 *   older npm (Node 22 / CI) → `[{ filename, files, ... }]`
 *   npm 12+ (Node 24 locally) → `{ "<name>": { filename, files, ... } }`
 *
 * The dual-shape read already exists for the published-tarball probe
 * (`test/npm-binary-distribution.test.ts`). Workflow-core pack/test/publish
 * scripts still scanned only for a leading `[`, so npm 12 never even reached
 * JSON.parse. Normalize both shapes to an array of pack records.
 *
 * Also skip any banner lines before the first JSON value.
 */
export function parseNpmPackJson(stdout) {
  const jsonStart = stdout.search(/^\s*[\[{]/m);
  if (jsonStart < 0) throw new Error(`npm pack returned no JSON:\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(jsonStart));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed);
  throw new Error(`npm pack returned unexpected JSON:\n${stdout}`);
}
