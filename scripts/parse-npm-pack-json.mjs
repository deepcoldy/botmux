/**
 * `npm pack --json` changed its top-level shape across majors:
 *   older npm (Node 22 / CI) → `[{ filename, files, ... }]`
 *   npm 12+ (Node 24 locally) → `{ "<name>": { filename, files, ... } }`
 *
 * stdout is not a clean JSON document. Notices, lifecycle leftovers, and
 * `[workflow-core] built …` from `prepare` can sit in front of the value.
 * A scan for "first `[` or `{` at line start" is wrong: that matches the
 * log tag and never reaches the real array (CI build job, Node 22).
 *
 * Only treat a line as JSON if it is a pretty-printed `[`, a compact
 * array (`[{` / `[[`), or an object (`{`). Try candidates from the end
 * so a trailing pack report wins over an earlier false start.
 */
export function parseNpmPackJson(stdout) {
  const starts = [];
  const re = /^[ \t]*(?:\[\s*$|\[\s*[{\[]|\{)/gm;
  for (const match of stdout.matchAll(re)) {
    starts.push(match.index + match[0].search(/\S/));
  }
  for (const start of starts.reverse()) {
    try {
      return normalizePackList(JSON.parse(stdout.slice(start)));
    } catch {
      /* try an earlier candidate */
    }
  }
  throw new Error(`npm pack returned no JSON:\n${stdout}`);
}

function normalizePackList(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return Object.values(parsed);
  throw new Error(`npm pack returned unexpected JSON`);
}
